/**
 * Regression coverage for the .git pack corruption observed in prod
 * (memory-git@3.6.1, pods-manager 2026-05-22):
 *
 *   - copyDiskToMemoryIncremental propagated ENOENT from a sibling readdir/
 *     stat/readFile when a concurrent `git gc` mutated .git/, leaving memfs
 *     and the disk-snapshot in a partial state without the deletion sweep
 *     that loadFromDisk normally runs.
 *
 *   - copyMemoryToDiskIncremental only short-circuited immutable git-object
 *     writes when realPathExists(disk) was true. When an external `git gc`
 *     had removed pack-AAA.{pack,idx} from disk, the writeback resurrected
 *     the stale memfs copies, producing the observed `.idx` / `.pack` mtime
 *     divergence and `unknown object type 0 at offset ...` reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'fs';
import { promises as fsRealAsync } from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { createFsFromVolume, Volume } from 'memfs';
import ignore from 'ignore';
import {
    copyDiskToMemoryIncremental,
    copyMemoryToDisk,
    copyMemoryToDiskIncremental,
    indexDiskLazy,
    listFilesRecursive,
    type FileFingerprint,
} from '../src/disk-sync';
import { MemoryGit } from '../src/index';

const execFile = promisify(execFileCb);

const enoent = (p: string) => {
    const err = new Error(`ENOENT: no such file or directory, '${p}'`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
};

const git = async (cwd: string, ...args: string[]) =>
    execFile('git', args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@t',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@t',
        },
    });

describe('disk-sync race resilience (unit)', () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fsRealAsync.mkdtemp(path.join(os.tmpdir(), 'mg-race-'));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fsRealAsync.rm(tmp, { recursive: true, force: true });
    });

    it('copyDiskToMemoryIncremental: stat ENOENT mid-walk is swallowed (file vanished)', async () => {
        for (let i = 0; i < 10; i++) {
            await fsRealAsync.writeFile(path.join(tmp, `f${i}.txt`), `c${i}`);
        }
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });

        const realStat = nodeFs.promises.stat.bind(nodeFs.promises);
        vi.spyOn(nodeFs.promises, 'stat').mockImplementation((async (p: string, ...rest: unknown[]) => {
            if (typeof p === 'string' && p.endsWith('f3.txt')) throw enoent(p);
            return realStat(p as string, ...(rest as []));
        }) as typeof nodeFs.promises.stat);

        const snapshot = new Map<string, FileFingerprint>();
        const seen = new Set<string>();
        const result = await copyDiskToMemoryIncremental(
            fs, tmp, '/repo', ignore(), '', snapshot, seen,
        );

        expect(result.read).toBe(9);
        // f3.txt vanished mid-walk — must NOT be in `seen`, so the caller's
        // deletion sweep can purge any stale snapshot entry for it.
        expect(seen.has('f3.txt')).toBe(false);
        expect(seen.has('f0.txt')).toBe(true);
        expect(fs.readFileSync('/repo/f0.txt', 'utf8')).toBe('c0');
    });

    it('copyDiskToMemoryIncremental: readFile ENOENT mid-walk is swallowed', async () => {
        for (let i = 0; i < 10; i++) {
            await fsRealAsync.writeFile(path.join(tmp, `f${i}.txt`), `c${i}`);
        }
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });

        const realRead = nodeFs.promises.readFile.bind(nodeFs.promises);
        vi.spyOn(nodeFs.promises, 'readFile').mockImplementation((async (p: string, ...rest: unknown[]) => {
            if (typeof p === 'string' && p.endsWith('f7.txt')) throw enoent(p);
            return realRead(p as string, ...(rest as []));
        }) as typeof nodeFs.promises.readFile);

        const snapshot = new Map<string, FileFingerprint>();
        const seen = new Set<string>();
        await expect(
            copyDiskToMemoryIncremental(fs, tmp, '/repo', ignore(), '', snapshot, seen),
        ).resolves.toMatchObject({ read: 9 });
        expect(seen.has('f7.txt')).toBe(false);
    });

    it('copyDiskToMemoryIncremental: subdir readdir ENOENT (dir deleted by gc) is swallowed', async () => {
        await fsRealAsync.mkdir(path.join(tmp, 'subA'));
        await fsRealAsync.writeFile(path.join(tmp, 'subA', 'a.txt'), 'a');
        await fsRealAsync.mkdir(path.join(tmp, 'subB'));
        await fsRealAsync.writeFile(path.join(tmp, 'subB', 'b.txt'), 'b');

        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });

        const realReaddir = nodeFs.promises.readdir.bind(nodeFs.promises);
        vi.spyOn(nodeFs.promises, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
            if (typeof p === 'string' && p.endsWith('subB')) throw enoent(p);
            return (realReaddir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
        }) as typeof nodeFs.promises.readdir);

        const snapshot = new Map<string, FileFingerprint>();
        const seen = new Set<string>();
        const result = await copyDiskToMemoryIncremental(
            fs, tmp, '/repo', ignore(), '', snapshot, seen,
        );

        expect(result.read).toBe(1); // subA/a.txt only
        expect(seen.has('subA/a.txt')).toBe(true);
        expect(seen.has('subB/b.txt')).toBe(false);
        // No memfs dir for a flush to recreate on disk.
        expect(fs.existsSync('/repo/subB')).toBe(false);
    });

    it('indexDiskLazy: a loose ref pruned between readdir and stat is left out', async () => {
        const tags = path.join(tmp, '.git', 'refs', 'tags');
        await fsRealAsync.mkdir(tags, { recursive: true });
        for (let i = 0; i < 5; i++) await fsRealAsync.writeFile(path.join(tags, `v${i}`), `oid${i}\n`);
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });

        // `git pack-refs` deletes v3 right after our readdir listed it.
        const realStat = nodeFs.promises.stat.bind(nodeFs.promises);
        vi.spyOn(nodeFs.promises, 'stat').mockImplementation((async (p: string, ...rest: unknown[]) => {
            if (typeof p === 'string' && p.endsWith(`${path.sep}v3`)) throw enoent(p);
            return realStat(p as string, ...(rest as []));
        }) as typeof nodeFs.promises.stat);

        const indexed: string[] = [];
        const count = await indexDiskLazy(fs, tmp, '/repo', ignore(), '', (memPath) => indexed.push(memPath));

        expect(count).toBe(4);
        expect(indexed).not.toContain('/repo/.git/refs/tags/v3');
        expect(indexed).toContain('/repo/.git/refs/tags/v0');
    });

    it('indexDiskLazy: a subdir deleted mid-walk leaves no memfs dir, a missing root still throws', async () => {
        await fsRealAsync.mkdir(path.join(tmp, 'empty'));
        await fsRealAsync.mkdir(path.join(tmp, 'subA'));
        await fsRealAsync.writeFile(path.join(tmp, 'subA', 'a.txt'), 'a');
        await fsRealAsync.mkdir(path.join(tmp, 'subB'));
        await fsRealAsync.writeFile(path.join(tmp, 'subB', 'b.txt'), 'b');
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });

        const realReaddir = nodeFs.promises.readdir.bind(nodeFs.promises);
        vi.spyOn(nodeFs.promises, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
            if (typeof p === 'string' && p.endsWith('subB')) throw enoent(p);
            return (realReaddir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
        }) as typeof nodeFs.promises.readdir);

        const indexed: string[] = [];
        await expect(
            indexDiskLazy(fs, tmp, '/repo', ignore(), '', (memPath) => indexed.push(memPath)),
        ).resolves.toBe(1);
        expect(indexed).toEqual(['/repo/subA/a.txt']);
        // No memfs dir for a flush to recreate on disk; one that exists stays.
        expect(fs.existsSync('/repo/subB')).toBe(false);
        expect(fs.existsSync('/repo/empty')).toBe(true);
        await expect(
            indexDiskLazy(fs, path.join(tmp, 'gone'), '/repo', ignore(), '', () => undefined),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('copyMemoryToDiskIncremental: drops stale immutable pack from memfs+snapshot when disk-missing', async () => {
        // Simulates: memfs holds pack-AAA.{pack,idx} from a prior load; an
        // external `git gc` has removed them from disk. Without the fix,
        // copyMemoryToDiskIncremental resurrects the stale bytes (the bug);
        // with the fix, it drops them from memfs+snapshot instead.
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo/.git/objects/pack', { recursive: true });

        const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const packRel = `.git/objects/pack/pack-${sha}.pack`;
        const idxRel = `.git/objects/pack/pack-${sha}.idx`;
        const stalePack = Buffer.from('OLD_PACK_BYTES');
        const staleIdx = Buffer.from('OLD_IDX_BYTES');

        fs.writeFileSync('/repo/' + packRel, stalePack);
        fs.writeFileSync('/repo/' + idxRel, staleIdx);

        const snapshot = new Map<string, FileFingerprint>();
        snapshot.set(packRel, { size: stalePack.length, mtimeMs: 1, hash: 'pack-old-hash' });
        snapshot.set(idxRel, { size: staleIdx.length, mtimeMs: 1, hash: 'idx-old-hash' });

        // tmp exists but has no .git/ contents — represents disk after external gc.
        const seen = new Set<string>();
        await copyMemoryToDiskIncremental(fs, '/repo', tmp, '', snapshot, seen);

        // Stale pack/idx must NOT have been resurrected on disk.
        await expect(fsRealAsync.access(path.join(tmp, packRel)))
            .rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fsRealAsync.access(path.join(tmp, idxRel)))
            .rejects.toMatchObject({ code: 'ENOENT' });

        // Memfs + snapshot are now consistent with disk: empty of pack-AAA.*
        expect(fs.existsSync('/repo/' + packRel)).toBe(false);
        expect(fs.existsSync('/repo/' + idxRel)).toBe(false);
        expect(snapshot.has(packRel)).toBe(false);
        expect(snapshot.has(idxRel)).toBe(false);
    });

    it('copyMemoryToDiskIncremental: NEW immutable object in memfs (not in snapshot) is still written', async () => {
        // Edge case the drop-logic must not break: an immutable object that
        // exists in memfs but never existed on disk (e.g. an isomorphic-git
        // commit produced a new loose object). Must be written, not dropped.
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo/.git/objects/02', { recursive: true });

        const looseRel = '.git/objects/02/abcdef0123456789abcdef0123456789abcdef';
        fs.writeFileSync('/repo/' + looseRel, Buffer.from('newobj'));

        await fsRealAsync.mkdir(path.join(tmp, '.git/objects/02'), { recursive: true });

        const snapshot = new Map<string, FileFingerprint>();
        const seen = new Set<string>();
        const result = await copyMemoryToDiskIncremental(fs, '/repo', tmp, '', snapshot, seen);

        expect(result.written).toBe(1);
        expect(await fsRealAsync.readFile(path.join(tmp, looseRel), 'utf8')).toBe('newobj');
        expect(snapshot.has(looseRel)).toBe(true);
    });

    it('copyMemoryToDiskIncremental: existing-on-disk immutable path remains skipped (no regression)', async () => {
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo/.git/objects/pack', { recursive: true });
        const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const packRel = `.git/objects/pack/pack-${sha}.pack`;
        fs.writeFileSync('/repo/' + packRel, Buffer.from('memfs-pack'));

        // Disk already has the same pack (different bytes — we want to prove
        // the skip happens BY PATH, not by content compare).
        await fsRealAsync.mkdir(path.join(tmp, '.git/objects/pack'), { recursive: true });
        await fsRealAsync.writeFile(path.join(tmp, packRel), Buffer.from('disk-pack'));

        const snapshot = new Map<string, FileFingerprint>();
        const seen = new Set<string>();
        const result = await copyMemoryToDiskIncremental(fs, '/repo', tmp, '', snapshot, seen);

        expect(result.written).toBe(0);
        expect(result.skipped).toBe(1);
        // Disk bytes untouched.
        expect(await fsRealAsync.readFile(path.join(tmp, packRel), 'utf8')).toBe('disk-pack');
    });
});

describe('disk-sync race integration (native git)', () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fsRealAsync.mkdtemp(path.join(os.tmpdir(), 'mg-race-int-'));
    });

    afterEach(async () => {
        await fsRealAsync.rm(tmp, { recursive: true, force: true });
    });

    it('REGRESSION: flush after external gc does NOT resurrect deleted pack files', async () => {
        // Deterministic reproduction of the prod corruption signature.
        // 1. Build a repo with enough objects that gc produces a pack.
        // 2. Load it into memory-git (memfs+snapshot now hold pack-AAA.*).
        // 3. Simulate the kernel-strategy gap: an external git operation
        //    removes the pack files (gc → repack → prune).
        // 4. Call flush(). Pre-fix: copyMemoryToDiskIncremental sees the
        //    pack paths missing on disk, bypasses the immutable-skip, and
        //    writes the stale bytes back — corrupting the repo's view of
        //    its own objects. Post-fix: drops them from memfs.
        await git(tmp, 'init', '-b', 'main');
        await git(tmp, 'config', 'gc.auto', '0');
        for (let i = 0; i < 30; i++) {
            await fsRealAsync.writeFile(path.join(tmp, `f${i}.txt`), `content-${i}\n`);
            await git(tmp, 'add', '-A');
            await git(tmp, 'commit', '-m', `c${i}`);
        }
        await git(tmp, 'gc', '--quiet');

        const packDir = path.join(tmp, '.git/objects/pack');
        const packsBefore = (await fsRealAsync.readdir(packDir))
            .filter(f => f.startsWith('pack-'));
        expect(packsBefore.length).toBeGreaterThan(0);

        const mg = new MemoryGit('race-int');
        await mg.loadFromDisk(tmp);

        // External mutation: drop the pack files entirely. This is the
        // narrow window the prod scenario hits (gc deleting pack-AAA before
        // memory-git has re-loaded).
        for (const f of packsBefore) {
            await fsRealAsync.rm(path.join(packDir, f));
        }

        await mg.flush();

        // The killer assertion: stale pack files must NOT be on disk.
        const packsAfter = (await fsRealAsync.readdir(packDir).catch(() => []))
            .filter(f => f.startsWith('pack-'));
        for (const f of packsBefore) {
            expect(packsAfter).not.toContain(f);
        }

        // And memory-git's view of those pack paths must be cleared so the
        // next flush is a no-op for them.
        const files = await mg.listFiles('', true);
        for (const f of packsBefore) {
            expect(files).not.toContain(`.git/objects/pack/${f}`);
        }
    }, 60_000);

    it('REGRESSION: loadFromDisk survives concurrent gc deleting object subdirs', async () => {
        // Stresses fix A: while loadFromDisk is walking .git/objects/, a gc
        // running in parallel deletes loose-object subdirs (objects/XX/).
        // Pre-fix: ENOENT propagates → loadFromDisk rejects.
        // Post-fix: walk completes, dropped entries are reconciled.
        await git(tmp, 'init', '-b', 'main');
        await git(tmp, 'config', 'gc.auto', '0');
        for (let i = 0; i < 40; i++) {
            await fsRealAsync.writeFile(path.join(tmp, `f${i}.txt`), `content-${i}\n`);
            await git(tmp, 'add', '-A');
            await git(tmp, 'commit', '-m', `c${i}`);
        }

        const mg = new MemoryGit('race-load');
        const ITERATIONS = 8;
        for (let i = 0; i < ITERATIONS; i++) {
            const results = await Promise.allSettled([
                mg.loadFromDisk(tmp),
                git(tmp, 'gc', '--quiet'),
            ]);
            // loadFromDisk must never reject because of a racing gc.
            const loadResult = results[0];
            expect(loadResult.status).toBe('fulfilled');
        }

        // Final sanity: the on-disk repo is still readable by native git.
        const fsck = await execFile('git', ['fsck', '--full', '--no-progress'], {
            cwd: tmp,
        }).catch(e => e);
        const out = (fsck.stdout || '') + (fsck.stderr || '');
        expect(out).not.toMatch(/unknown object type|pack checksum mismatch|cannot unpack/);
    }, 60_000);
});

/**
 * Regression coverage for the dangling-symlink crash (memory-git@3.10.4):
 * listFilesRecursive used statSync, which *follows* symlinks. A dead symlink
 * (e.g. a `node_modules` pointing at a deleted cache) made statSync throw
 * ENOENT and abort the entire walk. lstatSync treats symlinks as leaves and
 * never resolves their target, so the listing stays intact.
 */
describe('listFilesRecursive symlink resilience (unit)', () => {
    it('does not throw on a dangling symlink and lists it as a leaf', () => {
        const vol = new Volume();
        const fs = createFsFromVolume(vol);
        fs.mkdirSync('/repo', { recursive: true });
        fs.writeFileSync('/repo/README.md', '# test');
        // Dead symlink: target does not exist. statSync would throw ENOENT here.
        fs.symlinkSync('/does/not/exist', '/repo/node_modules');

        let files: string[] = [];
        expect(() => {
            files = listFilesRecursive(fs as any, '/repo');
        }).not.toThrow();

        expect(files).toContain('README.md');
        // The dead symlink is surfaced as a leaf, not followed/descended.
        expect(files).toContain('node_modules');
    });

    it('treats a symlink to a directory as a leaf rather than descending', () => {
        const vol = new Volume();
        const fs = createFsFromVolume(vol);
        fs.mkdirSync('/repo/real', { recursive: true });
        fs.writeFileSync('/repo/real/inner.js', 'code');
        // Live symlink pointing at a real directory.
        fs.symlinkSync('/repo/real', '/repo/link');

        const files = listFilesRecursive(fs as any, '/repo');

        expect(files).toContain('real/inner.js');
        // We must not follow the symlink into the target directory.
        expect(files).toContain('link');
        expect(files).not.toContain('link/inner.js');
    });

    it('skips an entry that vanishes between readdir and lstat', () => {
        const vol = new Volume();
        const fs = createFsFromVolume(vol);
        fs.mkdirSync('/repo', { recursive: true });
        fs.writeFileSync('/repo/keep.txt', 'keep');
        fs.writeFileSync('/repo/gone.txt', 'gone');

        const realLstat = fs.lstatSync.bind(fs);
        const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: any, opts?: any) => {
            if (typeof p === 'string' && p.endsWith('/gone.txt')) throw enoent(p);
            return realLstat(p, opts);
        }) as typeof fs.lstatSync);

        let files: string[] = [];
        expect(() => {
            files = listFilesRecursive(fs as any, '/repo');
        }).not.toThrow();

        expect(files).toContain('keep.txt');
        expect(files).not.toContain('gone.txt');
        spy.mockRestore();
    });
});

/**
 * Regression coverage for the dangling-symlink crash on the flush path
 * (memory-git@3.10.4): copyMemoryToDisk / copyMemoryToDiskIncremental used
 * statSync, which follows symlinks. A dead symlink in the in-memory tree
 * (e.g. a node_modules pointing at an emptyDir cache wiped on pod restart)
 * made statSync throw ENOENT and abort the whole flush. We now lstat and
 * replicate the link itself instead of resolving it.
 */
describe('copyMemoryToDisk symlink resilience (unit)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fsRealAsync.mkdtemp(path.join(os.tmpdir(), 'mg-sym-'));
    });
    afterEach(async () => {
        await fsRealAsync.rm(tmpDir, { recursive: true, force: true });
    });

    it('copyMemoryToDisk: replicates a dangling symlink instead of throwing', async () => {
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });
        fs.writeFileSync('/repo/README.md', '# test');
        fs.symlinkSync('/does/not/exist', '/repo/node_modules');

        // Pre-fix this rejected with ENOENT on node_modules.
        const count = await copyMemoryToDisk(fs as any, '/repo', tmpDir);

        // The regular file is written…
        expect(await fsRealAsync.readFile(path.join(tmpDir, 'README.md'), 'utf8')).toBe('# test');
        // …and the dead symlink is replicated as a symlink (not resolved/crashed).
        const ls = await fsRealAsync.lstat(path.join(tmpDir, 'node_modules'));
        expect(ls.isSymbolicLink()).toBe(true);
        expect(await fsRealAsync.readlink(path.join(tmpDir, 'node_modules'))).toBe('/does/not/exist');
        expect(count).toBe(2);
    });

    it('copyMemoryToDisk: replicates a live symlink without resolving its target', async () => {
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo/real', { recursive: true });
        fs.writeFileSync('/repo/real/inner.js', 'code');
        fs.symlinkSync('/repo/real', '/repo/link');

        await copyMemoryToDisk(fs as any, '/repo', tmpDir);

        const ls = await fsRealAsync.lstat(path.join(tmpDir, 'link'));
        expect(ls.isSymbolicLink()).toBe(true);
        expect(await fsRealAsync.readlink(path.join(tmpDir, 'link'))).toBe('/repo/real');
        // The link must not have been followed and copied as a directory.
        await expect(fsRealAsync.access(path.join(tmpDir, 'link/inner.js')))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('copyMemoryToDiskIncremental: replicates a dangling symlink and tracks it in seen', async () => {
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });
        fs.symlinkSync('/gone/cache', '/repo/node_modules');

        const snapshot = new Map<string, FileFingerprint>();
        const seen = new Set<string>();
        const result = await copyMemoryToDiskIncremental(fs as any, '/repo', tmpDir, '', snapshot, seen);

        const ls = await fsRealAsync.lstat(path.join(tmpDir, 'node_modules'));
        expect(ls.isSymbolicLink()).toBe(true);
        expect(await fsRealAsync.readlink(path.join(tmpDir, 'node_modules'))).toBe('/gone/cache');
        // In `seen` (so `clean` won't delete it) but NOT in `snapshot` (no content hash).
        expect(seen.has('node_modules')).toBe(true);
        expect(snapshot.has('node_modules')).toBe(false);
        expect(result.written).toBe(1);
    });

    it('copyMemoryToDiskIncremental: re-flush skips an already-correct symlink', async () => {
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });
        fs.symlinkSync('/gone/cache', '/repo/node_modules');

        const snapshot = new Map<string, FileFingerprint>();
        const seen1 = new Set<string>();
        await copyMemoryToDiskIncremental(fs as any, '/repo', tmpDir, '', snapshot, seen1);

        const seen2 = new Set<string>();
        const result = await copyMemoryToDiskIncremental(fs as any, '/repo', tmpDir, '', snapshot, seen2);

        // Link target already matches → no rewrite.
        expect(result.written).toBe(0);
        expect(result.skipped).toBe(1);
        expect(seen2.has('node_modules')).toBe(true);
    });
});
