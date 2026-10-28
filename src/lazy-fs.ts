/**
 * Lazy disk-backed fs wrapper.
 *
 * Used when `new MemoryGit('name', { lazy: true })`. `loadFromDisk` walks the
 * source tree but does NOT read file contents — every file path it encounters
 * is recorded in `LazyState`, and the in-memory volume only holds the
 * directory skeleton. Reads through the wrapped fs (sync, callback-async,
 * promises) fault the file in on demand: the bytes are read from disk, written
 * into memfs, hashed into the disk snapshot, and the lazy index entry is
 * dropped. Anything never touched stays out of RAM.
 *
 * Writes and deletes update the lazy index too: writing a lazy path removes
 * the entry (memfs now owns the truth); unlinking a lazy path produces a
 * tombstone that flush propagates as a disk-side delete.
 *
 * Directories are eagerly mkdir'd in memfs during the index walk — they're
 * O(1) in memfs and keep readdir/stat semantics on directories trivial. Only
 * regular files participate in the lazy index.
 */

import { promises as fsRealAsync, readFileSync as fsRealReadFileSync, statSync as fsRealStatSync, type Stats } from 'fs';
import pathNode from 'path';
import type { createFsFromVolume } from 'memfs';
import { hashBuffer } from './disk-sync.js';
import { normalize } from './fs-path.js';

type MemFs = ReturnType<typeof createFsFromVolume>;

/** One file the wrapper knows about but hasn't read yet. */
export interface LazyFileEntry {
    /** Absolute path on the real filesystem. */
    realPath: string;
    /**
     * Size in bytes, from stat at index time. Undefined for entries indexed
     * without a stat (content-addressed git objects) until the first stat.
     */
    size?: number;
    /** Disk mtime in ms. Same lifecycle as `size`. */
    mtimeMs?: number;
}

/**
 * Callback invoked the first time a lazy path is faulted into memfs. The
 * MemoryGit instance uses this to slot the new file into its disk snapshot
 * so subsequent flushes can skip rewriting it.
 */
export type MaterializeListener = (
    memPath: string,
    size: number,
    mtimeMs: number,
    hash: string,
) => void;

/**
 * Bookkeeping for lazy mode.
 *
 * `files` is the authoritative index: while a path is here, its bytes are
 * still on disk and absent from memfs. As soon as it's materialized (or
 * written, or deleted by the user) the entry leaves `files`.
 *
 * `fileChildren` mirrors `files` keyed by parent directory so readdir can
 * union memfs entries with not-yet-materialized children in O(1).
 *
 * `tombstones` records paths the user unlinked while they were lazy — they
 * never entered memfs, so the normal "memfs walk + snapshot diff" deletion
 * path in flush() can't see them. flush() processes tombstones unconditionally
 * to propagate the deletion to disk.
 */
export class LazyState {
    readonly files: Map<string, LazyFileEntry> = new Map();
    readonly fileChildren: Map<string, Set<string>> = new Map();
    readonly tombstones: Set<string> = new Set();

    /** Register a file under its memfs path. Also records it under its parent. */
    addFile(memPath: string, entry: LazyFileEntry): void {
        this.files.set(memPath, entry);
        const parent = pathNode.posix.dirname(memPath);
        const base = pathNode.posix.basename(memPath);
        let set = this.fileChildren.get(parent);
        if (!set) {
            set = new Set();
            this.fileChildren.set(parent, set);
        }
        set.add(base);
        // A subsequent re-add overrides a prior tombstone for the same path.
        this.tombstones.delete(memPath);
    }

    /** Drop a file from the index. Called on materialize or user write. */
    forgetFile(memPath: string): LazyFileEntry | undefined {
        const entry = this.files.get(memPath);
        if (!entry) return undefined;
        this.files.delete(memPath);
        const parent = pathNode.posix.dirname(memPath);
        const set = this.fileChildren.get(parent);
        if (set) {
            set.delete(pathNode.posix.basename(memPath));
            if (set.size === 0) this.fileChildren.delete(parent);
        }
        return entry;
    }

    /**
     * Forget a lazy file and mark it for disk-side deletion at the next flush.
     * No-op if the path isn't lazy (callers should let memfs handle its own
     * delete first).
     */
    tombstoneFile(memPath: string): boolean {
        const had = this.forgetFile(memPath);
        if (!had) return false;
        this.tombstones.add(memPath);
        return true;
    }

    /** Clear everything. Used by MemoryGit.clear(). */
    reset(): void {
        this.files.clear();
        this.fileChildren.clear();
        this.tombstones.clear();
    }
}

/** Internal: minimal Stats stand-in returned for unmaterialized files. */
class LazyFileStats {
    readonly size: number;
    readonly mtimeMs: number;
    readonly mtime: Date;
    readonly atimeMs: number;
    readonly atime: Date;
    readonly ctimeMs: number;
    readonly ctime: Date;
    readonly birthtimeMs: number;
    readonly birthtime: Date;
    readonly mode = 0o100644;
    readonly uid = 0;
    readonly gid = 0;
    readonly dev = 0;
    readonly ino = 0;
    readonly nlink = 1;
    readonly rdev = 0;
    readonly blksize = 4096;
    readonly blocks: number;

    constructor(size: number, mtimeMs: number) {
        this.size = size;
        this.mtimeMs = mtimeMs;
        this.mtime = new Date(mtimeMs);
        this.atimeMs = mtimeMs;
        this.atime = this.mtime;
        this.ctimeMs = mtimeMs;
        this.ctime = this.mtime;
        this.birthtimeMs = mtimeMs;
        this.birthtime = this.mtime;
        this.blocks = Math.ceil(size / 512);
    }

    isFile() { return true; }
    isDirectory() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isSymbolicLink() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

/** Internal: minimal Dirent stand-in for lazy children in withFileTypes readdir. */
class LazyDirent {
    constructor(public name: string) {}
    isFile() { return true; }
    isDirectory() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isSymbolicLink() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

function makeEnoent(memPath: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${memPath}'`);
    err.code = 'ENOENT';
    err.errno = -2;
    err.syscall = 'open';
    err.path = memPath;
    return err;
}

/**
 * Wrap a memfs `fs` so reads fault unmaterialized files in from disk.
 *
 * The returned object is a Proxy that exposes the exact same surface as the
 * underlying `fs` (sync, callback-async, and `.promises`), but intercepts
 * the read/stat/readdir/exists family and a few write/delete methods that
 * need to keep the lazy index consistent.
 *
 * `onMaterialize` is invoked once per file the wrapper faults in, so the
 * caller can update its disk snapshot.
 */
export function wrapLazyFs(
    memfs: MemFs,
    state: LazyState,
    onMaterialize: MaterializeListener,
): MemFs {
    // Materialize a lazy file synchronously. Returns the freshly-read buffer.
    // Caller is responsible for forgetting the entry from state.files before
    // returning to user code (we forget here so re-entrant reads don't loop).
    const materializeSync = (memPath: string, entry: LazyFileEntry): Buffer => {
        let content: Buffer;
        try {
            content = fsRealReadFileSync(entry.realPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                // Disk file vanished between index time and now. Treat as a
                // disappearance: forget the lazy entry, surface ENOENT.
                state.forgetFile(memPath);
                throw makeEnoent(memPath);
            }
            throw err;
        }
        // Stat again in case the file changed after we indexed it — the
        // snapshot needs the bytes' current mtimeMs, not what we recorded.
        let mtimeMs = entry.mtimeMs;
        try {
            mtimeMs = fsRealStatSync(entry.realPath).mtimeMs;
        } catch {
            // Use indexed mtime as fallback.
        }
        memfs.mkdirSync(pathNode.posix.dirname(memPath), { recursive: true });
        memfs.writeFileSync(memPath, content);
        state.forgetFile(memPath);
        onMaterialize(memPath, content.length, mtimeMs ?? 0, hashBuffer(content));
        return content;
    };

    const materializeAsync = async (memPath: string, entry: LazyFileEntry): Promise<Buffer> => {
        let content: Buffer;
        try {
            content = await fsRealAsync.readFile(entry.realPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                state.forgetFile(memPath);
                throw makeEnoent(memPath);
            }
            throw err;
        }
        let mtimeMs = entry.mtimeMs;
        try {
            const s = await fsRealAsync.stat(entry.realPath);
            mtimeMs = s.mtimeMs;
        } catch {
            // Fall back to indexed mtime.
        }
        memfs.mkdirSync(pathNode.posix.dirname(memPath), { recursive: true });
        memfs.writeFileSync(memPath, content);
        state.forgetFile(memPath);
        onMaterialize(memPath, content.length, mtimeMs ?? 0, hashBuffer(content));
        return content;
    };

    // Entries indexed without a stat (see indexDiskLazy) learn their size and
    // mtime on the first stat request. A file gone from disk by then is
    // forgotten and surfaces ENOENT, like a failed read.
    const statsOf = (memPath: string, entry: LazyFileEntry): LazyFileStats => {
        if (entry.size === undefined || entry.mtimeMs === undefined) {
            let real: Stats;
            try {
                real = fsRealStatSync(entry.realPath);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    state.forgetFile(memPath);
                    throw makeEnoent(memPath);
                }
                throw err;
            }
            entry.size = real.size;
            entry.mtimeMs = real.mtimeMs;
        }
        return new LazyFileStats(entry.size, entry.mtimeMs);
    };

    const statsOfAsync = async (memPath: string, entry: LazyFileEntry): Promise<LazyFileStats> => {
        if (entry.size === undefined || entry.mtimeMs === undefined) {
            let real: Stats;
            try {
                real = await fsRealAsync.stat(entry.realPath);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    state.forgetFile(memPath);
                    throw makeEnoent(memPath);
                }
                throw err;
            }
            entry.size = real.size;
            entry.mtimeMs = real.mtimeMs;
        }
        return new LazyFileStats(entry.size, entry.mtimeMs);
    };

    // ---------- sync overrides ----------

    const readFileSync = (p: any, opts?: any): any => {
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
        const entry = state.files.get(memPath);
        if (entry) {
            const buf = materializeSync(memPath, entry);
            const enc = typeof opts === 'string' ? opts : opts?.encoding;
            return enc ? buf.toString(enc) : buf;
        }
        return memfs.readFileSync(p, opts);
    };

    const statSync = (p: any, opts?: any): any => {
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
        const entry = state.files.get(memPath);
        if (entry) return statsOf(memPath, entry);
        return memfs.statSync(p, opts);
    };

    const lstatSync = (p: any, opts?: any): any => {
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
        const entry = state.files.get(memPath);
        if (entry) return statsOf(memPath, entry);
        return memfs.lstatSync(p, opts);
    };

    const existsSync = (p: any): boolean => {
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) return false;
        if (state.files.has(memPath)) return true;
        return memfs.existsSync(p);
    };

    const readdirSync = (p: any, opts?: any): any => {
        const memPath = normalize(p);
        const memEntries = memfs.readdirSync(p, opts) as any[];
        const lazyChildren = state.fileChildren.get(memPath);
        if (!lazyChildren || lazyChildren.size === 0) {
            // Still need to honour tombstones if any materialized entry was
            // deleted via the lazy path (unlikely, but consistent).
            return memEntries;
        }
        const withFileTypes = typeof opts === 'object' && opts?.withFileTypes;
        // memfs returns names by default, Dirent[] when withFileTypes.
        const result: any[] = [];
        const seenNames = new Set<string>();
        for (const e of memEntries) {
            const name = typeof e === 'string' ? e : e.name;
            const full = pathNode.posix.join(memPath, name);
            if (state.tombstones.has(full)) continue;
            seenNames.add(name);
            result.push(e);
        }
        for (const name of lazyChildren) {
            if (seenNames.has(name)) continue;
            const full = pathNode.posix.join(memPath, name);
            if (state.tombstones.has(full)) continue;
            result.push(withFileTypes ? new LazyDirent(name) : name);
        }
        return result;
    };

    const writeFileSync = (p: any, data: any, opts?: any): void => {
        const memPath = normalize(p);
        // User's write shadows whatever was on disk — drop the lazy entry so
        // a subsequent read returns this buffer rather than re-faulting from
        // disk. Also clears any tombstone for the same path (write-after-delete).
        state.forgetFile(memPath);
        state.tombstones.delete(memPath);
        memfs.writeFileSync(p, data, opts);
    };

    const unlinkSync = (p: any): void => {
        const memPath = normalize(p);
        // If the file is currently lazy (not in memfs), we need to remember
        // to remove it from disk at flush time — memfs has nothing to walk.
        if (state.files.has(memPath)) {
            state.tombstoneFile(memPath);
            return;
        }
        // Materialized: let memfs throw if missing; existing snapshot+clean
        // logic will reconcile disk on flush.
        memfs.unlinkSync(p);
    };

    const accessSync = (p: any, mode?: any): void => {
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
        if (state.files.has(memPath)) return;
        memfs.accessSync(p, mode);
    };

    // ---------- callback-async overrides ----------

    // Pulls the (opts, cb) tail apart in the node way: cb may be the second
    // or third argument.
    const splitOptsCb = (a: any, b: any): { opts: any; cb: any } => {
        if (typeof a === 'function') return { opts: undefined, cb: a };
        return { opts: a, cb: b };
    };

    const readFile = (p: any, optsOrCb: any, maybeCb?: any): void => {
        const { opts, cb } = splitOptsCb(optsOrCb, maybeCb);
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) return queueMicrotask(() => cb(makeEnoent(memPath)));
        const entry = state.files.get(memPath);
        if (entry) {
            materializeAsync(memPath, entry).then(buf => {
                const enc = typeof opts === 'string' ? opts : opts?.encoding;
                cb(null, enc ? buf.toString(enc) : buf);
            }).catch(cb);
            return;
        }
        (memfs as any).readFile(p, opts, cb);
    };

    const stat = (p: any, optsOrCb: any, maybeCb?: any): void => {
        const { opts, cb } = splitOptsCb(optsOrCb, maybeCb);
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) return queueMicrotask(() => cb(makeEnoent(memPath)));
        const entry = state.files.get(memPath);
        if (entry) {
            statsOfAsync(memPath, entry).then((st) => cb(null, st), cb);
            return;
        }
        (memfs as any).stat(p, opts, cb);
    };

    const lstat = (p: any, optsOrCb: any, maybeCb?: any): void => {
        const { opts, cb } = splitOptsCb(optsOrCb, maybeCb);
        const memPath = normalize(p);
        if (state.tombstones.has(memPath)) return queueMicrotask(() => cb(makeEnoent(memPath)));
        const entry = state.files.get(memPath);
        if (entry) {
            statsOfAsync(memPath, entry).then((st) => cb(null, st), cb);
            return;
        }
        (memfs as any).lstat(p, opts, cb);
    };

    const readdir = (p: any, optsOrCb: any, maybeCb?: any): void => {
        const { opts, cb } = splitOptsCb(optsOrCb, maybeCb);
        (memfs as any).readdir(p, opts, (err: any, memEntries: any[]) => {
            if (err) return cb(err);
            try {
                const memPath = normalize(p);
                const lazyChildren = state.fileChildren.get(memPath);
                if (!lazyChildren || lazyChildren.size === 0) return cb(null, memEntries);
                const withFileTypes = typeof opts === 'object' && opts?.withFileTypes;
                const result: any[] = [];
                const seenNames = new Set<string>();
                for (const e of memEntries) {
                    const name = typeof e === 'string' ? e : e.name;
                    const full = pathNode.posix.join(memPath, name);
                    if (state.tombstones.has(full)) continue;
                    seenNames.add(name);
                    result.push(e);
                }
                for (const name of lazyChildren) {
                    if (seenNames.has(name)) continue;
                    const full = pathNode.posix.join(memPath, name);
                    if (state.tombstones.has(full)) continue;
                    result.push(withFileTypes ? new LazyDirent(name) : name);
                }
                cb(null, result);
            } catch (e) {
                cb(e);
            }
        });
    };

    const writeFile = (p: any, data: any, optsOrCb: any, maybeCb?: any): void => {
        const { opts, cb } = splitOptsCb(optsOrCb, maybeCb);
        const memPath = normalize(p);
        state.forgetFile(memPath);
        state.tombstones.delete(memPath);
        (memfs as any).writeFile(p, data, opts, cb);
    };

    const unlink = (p: any, cb: any): void => {
        const memPath = normalize(p);
        if (state.files.has(memPath)) {
            state.tombstoneFile(memPath);
            return queueMicrotask(() => cb(null));
        }
        (memfs as any).unlink(p, cb);
    };

    // ---------- promises overrides ----------

    const promises = {
        readFile: async (p: any, opts?: any) => {
            const memPath = normalize(p);
            if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
            const entry = state.files.get(memPath);
            if (entry) {
                const buf = await materializeAsync(memPath, entry);
                const enc = typeof opts === 'string' ? opts : opts?.encoding;
                return enc ? buf.toString(enc) : buf;
            }
            return (memfs.promises as any).readFile(p, opts);
        },
        stat: async (p: any, opts?: any) => {
            const memPath = normalize(p);
            if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
            const entry = state.files.get(memPath);
            if (entry) return statsOfAsync(memPath, entry);
            return (memfs.promises as any).stat(p, opts);
        },
        lstat: async (p: any, opts?: any) => {
            const memPath = normalize(p);
            if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
            const entry = state.files.get(memPath);
            if (entry) return statsOfAsync(memPath, entry);
            return (memfs.promises as any).lstat(p, opts);
        },
        readdir: async (p: any, opts?: any) => {
            const memEntries = await (memfs.promises as any).readdir(p, opts) as any[];
            const memPath = normalize(p);
            const lazyChildren = state.fileChildren.get(memPath);
            if (!lazyChildren || lazyChildren.size === 0) return memEntries;
            const withFileTypes = typeof opts === 'object' && opts?.withFileTypes;
            const result: any[] = [];
            const seenNames = new Set<string>();
            for (const e of memEntries) {
                const name = typeof e === 'string' ? e : e.name;
                const full = pathNode.posix.join(memPath, name);
                if (state.tombstones.has(full)) continue;
                seenNames.add(name);
                result.push(e);
            }
            for (const name of lazyChildren) {
                if (seenNames.has(name)) continue;
                const full = pathNode.posix.join(memPath, name);
                if (state.tombstones.has(full)) continue;
                result.push(withFileTypes ? new LazyDirent(name) : name);
            }
            return result;
        },
        writeFile: async (p: any, data: any, opts?: any) => {
            const memPath = normalize(p);
            state.forgetFile(memPath);
            state.tombstones.delete(memPath);
            return (memfs.promises as any).writeFile(p, data, opts);
        },
        unlink: async (p: any) => {
            const memPath = normalize(p);
            if (state.files.has(memPath)) {
                state.tombstoneFile(memPath);
                return;
            }
            return (memfs.promises as any).unlink(p);
        },
        access: async (p: any, mode?: any) => {
            const memPath = normalize(p);
            if (state.tombstones.has(memPath)) throw makeEnoent(memPath);
            if (state.files.has(memPath)) return;
            return (memfs.promises as any).access(p, mode);
        },
    };

    // Overrides keyed by property name. The Proxy returns these first; any
    // other property pass-throughs to the underlying memfs (mkdirSync,
    // rmdirSync, chmodSync, the Volume/Stats classes, etc.).
    const overrides: Record<string, any> = {
        readFileSync, statSync, lstatSync, existsSync, readdirSync,
        writeFileSync, unlinkSync, accessSync,
        readFile, stat, lstat, readdir, writeFile, unlink,
    };

    return new Proxy(memfs, {
        get(target, prop: string | symbol) {
            if (typeof prop === 'string') {
                if (prop === 'promises') {
                    return new Proxy((target as any).promises, {
                        get(pt, pp: string | symbol) {
                            if (typeof pp === 'string' && pp in promises) {
                                return (promises as any)[pp];
                            }
                            const v = (pt as any)[pp];
                            return typeof v === 'function' ? v.bind(pt) : v;
                        },
                    });
                }
                if (prop in overrides) return overrides[prop];
            }
            const v = (target as any)[prop];
            return typeof v === 'function' ? v.bind(target) : v;
        },
    }) as MemFs;
}
