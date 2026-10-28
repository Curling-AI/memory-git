import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
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

function statCallsMatching(spy: { mock: { calls: unknown[][] } }, re: RegExp): unknown[][] {
    return spy.mock.calls.filter(([p]) => re.test(String(p)));
}

describe('lazy index of content-addressed git objects', () => {
    let realDir: string;
    let memGit: MemoryGit;

    beforeEach(async () => {
        realDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-lazy-immutable-'));
        await createRealRepo(realDir);
        memGit = new MemoryGit('lazy-immutable-test', { lazy: true });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        try { await fs.rm(realDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('loadFromDisk indexes loose objects without stat-ing them', async () => {
        const objects = await looseObjects(realDir);
        expect(objects.length).toBeGreaterThan(0);
        const statSpy = vi.spyOn(fsSync.promises, 'stat');

        await memGit.loadFromDisk(realDir);

        expect(statCallsMatching(statSpy, LOOSE_OBJECT_RE)).toEqual([]);
        // Working-tree files keep their stat: size and mtime drive change detection.
        expect(statCallsMatching(statSpy, /\/a\.txt$/).length).toBe(1);
        expect(await memGit.fileExists(objects[0])).toBe(true);
    });

    it('loadFromDisk indexes pack files without stat-ing them', async () => {
        execSync('git gc -q', { cwd: realDir });
        const statSpy = vi.spyOn(fsSync.promises, 'stat');

        await memGit.loadFromDisk(realDir);

        expect(statCallsMatching(statSpy, PACK_RE)).toEqual([]);
        const commits = await memGit.log();
        expect(commits.map(c => c.message.trim())).toEqual(['v2', 'initial']);
    });

    it('stat of an unread object returns its size and mtime from disk, without reading it', async () => {
        await memGit.loadFromDisk(realDir);
        const [rel] = await looseObjects(realDir);
        const onDisk = await fs.stat(path.join(realDir, rel));
        const memPath = path.posix.join(memGit.dir, rel);

        const viaSync = memGit.fs.statSync(memPath);
        const viaPromise = await memGit.fs.promises.lstat(memPath);
        const viaCallback = await new Promise<fsSync.Stats>((resolve, reject) => {
            memGit.fs.stat(memPath, (err: unknown, s: fsSync.Stats) => (err ? reject(err) : resolve(s)));
        });

        for (const s of [viaSync, viaPromise, viaCallback]) {
            expect(s.size).toBe(onDisk.size);
            expect(s.mtimeMs).toBe(onDisk.mtimeMs);
            expect(s.isFile()).toBe(true);
        }
        const inMemory = memGit.vol.toJSON() as Record<string, string | null>;
        expect(inMemory[memPath]).toBeUndefined();
    });

    it('stat of an unread object that vanished from disk throws ENOENT and forgets it', async () => {
        await memGit.loadFromDisk(realDir);
        const [rel] = await looseObjects(realDir);
        await fs.rm(path.join(realDir, rel), { force: true });
        const memPath = path.posix.join(memGit.dir, rel);

        let code: string | undefined;
        try {
            memGit.fs.statSync(memPath);
        } catch (err) {
            code = (err as NodeJS.ErrnoException).code;
        }

        expect(code).toBe('ENOENT');
        expect(memGit.fs.existsSync(memPath)).toBe(false);
    });

    it('reading an unread object still returns its bytes', async () => {
        await memGit.loadFromDisk(realDir);
        const [rel] = await looseObjects(realDir);

        const fromMemory = memGit.fs.readFileSync(path.posix.join(memGit.dir, rel)) as Buffer;

        expect(fromMemory.equals(await fs.readFile(path.join(realDir, rel)))).toBe(true);
    });
});
