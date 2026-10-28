import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { syncBuiltinESMExports } from 'module';
import { execSync } from 'child_process';
import { MemoryGit } from '../src/index';

const LOOSE_OBJECT_RE = /\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]+$/;
const PACK_RE = /\.git\/objects\/pack\/pack-[0-9a-f]+\.(pack|idx|rev)$/;

async function createRealRepo(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email "test@test"', { cwd: dir });
    execSync('git config user.name  "test"',       { cwd: dir });
    await fs.writeFile(path.join(dir, 'a.txt'), 'aaa\n');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'sub/b.txt'), 'bbb\n');
    execSync('git add -A',               { cwd: dir });
    execSync('git commit -q -m initial', { cwd: dir });
    await fs.writeFile(path.join(dir, 'a.txt'), 'aaa-v2\n');
    execSync('git commit -q -am v2',     { cwd: dir });
}

/** Repo-relative paths of every loose object on disk. */
async function looseObjects(dir: string): Promise<string[]> {
    const objects = path.join(dir, '.git', 'objects');
    const out: string[] = [];
    for (const fan of await fs.readdir(objects)) {
        if (!/^[0-9a-f]{2}$/.test(fan)) continue;
        for (const name of await fs.readdir(path.join(objects, fan))) {
            out.push(`.git/objects/${fan}/${name}`);
        }
    }
    return out;
}

/**
 * Spies on every real-disk stat flavour and returns the paths they were called
 * with. The library imports `statSync` by name, so the ESM bindings are
 * re-synced to the spied CommonJS exports.
 */
function spyRealStats(): () => string[] {
    const spies = [
        vi.spyOn(fsSync, 'statSync'),
        vi.spyOn(fsSync, 'lstatSync'),
        vi.spyOn(fsSync.promises, 'stat'),
        vi.spyOn(fsSync.promises, 'lstat'),
    ];
    syncBuiltinESMExports();
    return () => spies.flatMap(s => s.mock.calls.map(([p]) => String(p)));
}

const statCallback = (memGit: MemoryGit, p: string): Promise<fsSync.Stats> =>
    new Promise((resolve, reject) => {
        memGit.fs.stat(p, (err: unknown, s: fsSync.Stats) => (err ? reject(err) : resolve(s)));
    });

describe('lazy index of content-addressed git objects', () => {
    let realDir: string;
    let memGit: MemoryGit;
    let objects: string[];
    const memPathOf = (rel: string) => path.posix.join(memGit.dir, rel);

    beforeEach(async () => {
        realDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-lazy-immutable-'));
        await createRealRepo(realDir);
        objects = await looseObjects(realDir);
        memGit = new MemoryGit('lazy-immutable-test', { lazy: true });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        try { await fs.rm(realDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('loadFromDisk indexes loose objects without stat-ing them', async () => {
        expect(objects.length).toBeGreaterThanOrEqual(4);
        const statted = spyRealStats();

        await memGit.loadFromDisk(realDir);

        expect(statted().filter(p => LOOSE_OBJECT_RE.test(p))).toEqual([]);
        // Working-tree files keep their stat: size and mtime drive change detection.
        expect(statted().filter(p => p.endsWith('/a.txt'))).toHaveLength(1);
        expect(await memGit.fileExists(objects[0])).toBe(true);
    });

    it('loadFromDisk indexes pack files without stat-ing them', async () => {
        execSync('git gc -q', { cwd: realDir });
        const statted = spyRealStats();

        await memGit.loadFromDisk(realDir);

        expect(statted().filter(p => PACK_RE.test(p))).toEqual([]);
        const commits = await memGit.log();
        expect(commits.map(c => c.message.trim())).toEqual(['v2', 'initial']);
    });

    it('type checks on an unread object never touch disk, on every stat surface', async () => {
        await memGit.loadFromDisk(realDir);
        const statted = spyRealStats();

        const stats = [
            memGit.fs.statSync(memPathOf(objects[0])),
            memGit.fs.lstatSync(memPathOf(objects[1])),
            await memGit.fs.promises.stat(memPathOf(objects[2])),
            await statCallback(memGit, memPathOf(objects[3])),
        ];

        for (const s of stats) {
            expect(s.isFile()).toBe(true);
            expect(s.isDirectory()).toBe(false);
        }
        expect(statted()).toEqual([]);
    });

    it('size and mtime of an unread object come from disk once, on every stat surface', async () => {
        await memGit.loadFromDisk(realDir);
        const statted = spyRealStats();
        const surfaces = [
            (p: string) => memGit.fs.statSync(p),
            (p: string) => memGit.fs.promises.lstat(p),
            (p: string) => statCallback(memGit, p),
        ];

        for (const [i, statFn] of surfaces.entries()) {
            const rel = objects[i];
            const onDisk = await fs.stat(path.join(realDir, rel));
            const before = statted().length;

            const s = await statFn(memPathOf(rel));
            expect(s.size).toBe(onDisk.size);
            expect(s.mtimeMs).toBe(onDisk.mtimeMs);
            expect(s.mtime.getTime()).toBe(Math.trunc(onDisk.mtimeMs));
            expect({ ...s }.size).toBe(onDisk.size);
            // A second stat of the same entry reuses what the first one learned.
            expect((await statFn(memPathOf(rel))).size).toBe(onDisk.size);

            expect(statted().slice(before)).toEqual([path.join(realDir, rel)]);
        }
        const inMemory = memGit.vol.toJSON() as Record<string, string | null>;
        expect(inMemory[memPathOf(objects[0])]).toBeUndefined();
    });

    it('size of an unread object that vanished from disk throws ENOENT and forgets it', async () => {
        await memGit.loadFromDisk(realDir);
        const sync = memGit.fs.statSync(memPathOf(objects[0]));
        const viaCallback = await statCallback(memGit, memPathOf(objects[1]));
        await fs.rm(path.join(realDir, objects[0]), { force: true });
        await fs.rm(path.join(realDir, objects[1]), { force: true });

        for (const [s, rel] of [[sync, objects[0]], [viaCallback, objects[1]]] as const) {
            let code: string | undefined;
            try {
                void s.size;
            } catch (err) {
                code = (err as NodeJS.ErrnoException).code;
            }
            expect(code).toBe('ENOENT');
            expect(memGit.fs.existsSync(memPathOf(rel))).toBe(false);
        }
    });

    it('add and commit after a load only stat objects they actually read', async () => {
        await memGit.loadFromDisk(realDir);
        const statted = spyRealStats();
        const readSpies = [vi.spyOn(fsSync, 'readFileSync'), vi.spyOn(fsSync.promises, 'readFile')];
        syncBuiltinESMExports();

        await memGit.writeFile('c.txt', 'ccc\n');
        await memGit.add('.');
        await memGit.commit('v3');

        const read = new Set(readSpies.flatMap(s => s.mock.calls.map(([p]) => String(p))));
        const objectStats = statted().filter(p => LOOSE_OBJECT_RE.test(p));
        expect(objectStats.filter(p => !read.has(p))).toEqual([]);
        expect((await memGit.log()).map(c => c.message.trim())).toEqual(['v3', 'v2', 'initial']);
    });

    it('reading an unread object still returns its bytes', async () => {
        await memGit.loadFromDisk(realDir);

        const fromMemory = memGit.fs.readFileSync(memPathOf(objects[0])) as Buffer;

        expect(fromMemory.equals(await fs.readFile(path.join(realDir, objects[0])))).toBe(true);
    });
});
