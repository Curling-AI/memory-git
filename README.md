# MemoryGit

In-memory Git for AI agents, slow filesystems (EFS/NFS), and test harnesses. Run `git status`, `git commit -m "..."`, and every other common git command **as bash-like strings**, against an in-memory repo — no subprocess, no disk side effects until you call `flush()`.

```typescript
const mg = new MemoryGit();
await mg.init();
await mg.writeFile('README.md', '# hello');
await mg.exec('git add .');
await mg.exec('git commit -m "first"');
await mg.exec('git log --oneline');  // → "a1b2c3d first"
```

## Why this exists

AI coding agents and CI pipelines constantly call `git`. The standard path — `child_process.exec('git status')` against a `.git/` directory on disk — has real costs:

- **~3-4ms of subprocess overhead per call**, dominating runtime for fast operations.
- **`.git/` is a worst-case workload for slow filesystems.** A repo's `.git/objects/` has thousands of tiny files; every operation does many small reads/writes. EFS, NFS, networked dev-container volumes, and other high-latency storage amortize that poorly — a `git status` that takes 10ms locally can take seconds on EFS.
- **Real filesystem side effects** — every experimental commit is permanent until rolled back.
- **No isolation between parallel agents** — they fight over the working tree.
- **Opaque to the orchestrator** — you can't easily inspect what the agent ran.

MemoryGit solves these by running git purely in memory via [isomorphic-git](https://isomorphic-git.org/) on a per-instance [memfs](https://github.com/streamich/memfs) volume:

- **`exec(cmd: string)` — bash-like dispatcher.** Feed agents the same git CLI strings they'd run in a terminal. Pre-existing prompts, RAG examples, and tool definitions transfer directly.
- **No subprocess.** All ops resolve in-process. Overhead drops from ~3.6ms/call to ~0.03ms/call.
- **`.git/` stays off the slow disk.** Load the working tree from EFS/NFS once, do all git work in RAM, flush only the files you care about back. The thousands of small-file ops that kill networked storage never happen on disk.
- **Isolated per instance.** Spin up one MemoryGit per agent / task / branch attempt. Try, throw away, retry — no cleanup needed.
- **Operation log = audit trail.** Every method call (including via `exec`) is recorded with params, success/failure, and timestamps. Replay or summarize what the agent did.
- **Flush is explicit.** Memory state never touches disk until `flush()`. Agents can speculatively branch, commit, reset — and only persist the result you approve.

## Installation

```bash
npm install memory-git
# or
pnpm add memory-git
```

## Quickstart for agents

```typescript
import { MemoryGit } from 'memory-git';

const mg = new MemoryGit('agent-session-42');
mg.setAuthor('Agent Smith', 'agent@example.com');

await mg.loadFromDisk('./repo', { ignore: ['node_modules', 'dist'] });

// Hand `exec` straight to the agent — no parser, no shell escaping, no PTY.
await mg.exec('git checkout -b agent/fix-typo');
await mg.writeFile('src/util.ts', /* … */);
await mg.exec('git add src/util.ts');
await mg.exec('git commit -m "fix: typo in helper"');

// Inspect what the agent did before persisting
console.log(mg.exportOperationsLog());

// Persist only if you're happy with the result
await mg.flush();
```

## The `exec()` dispatcher

`exec(cmd)` accepts a bash-style git command string, strips a leading `git` if present, parses flags with `mri`, tokenizes with `shell-quote` (so `-m "messages with spaces"` work), and dispatches to the underlying TypeScript API.

```typescript
await mg.exec('status --porcelain');
await mg.exec('git log -n 5 --oneline');
await mg.exec('git commit --amend -m "reworded"');
await mg.exec('git diff HEAD~1 HEAD --name-only');
await mg.exec('git tag -a v1.0 -m "release"');
await mg.exec('git config user.name "Agent"');
```

### Supported subcommands

| Command | Notable flags |
|---|---|
| `init` | `-b/--initial-branch`, `--bare` |
| `add` | `<path...>`, `.`, `-A/--all`, `-u/--update` |
| `rm` | `<file>`, `--cached` |
| `mv` | `<from> <to>`, `-f` |
| `commit` | `-m <msg>`, `--amend`, `--allow-empty`, `-a/--all`, `--author=<n <e>>`, `--date=<iso>` |
| `status` | (default human-readable), `--porcelain`, `-s/--short`, `-b/--branch` |
| `log` | `-n <count>`, `--oneline`, `--author=<s>`, `--since=<iso>`, `--until=<iso>`, `--format=<fmt>`, `<ref>`. `--format` accepts the common placeholders (`%H`/`%h`/`%T`/`%t`/`%P`/`%p`/`%an`/`%ae`/`%ad`/`%ai`/`%at`/`%cn`/`%ce`/`%cd`/`%ci`/`%ct`/`%s`/`%b`/`%B`/`%n`/`%%`). Merge commits get a `Merge: <p1> <p2>` line in the default header. Date output matches git's `Thu Jan 1 00:00:00 2026 +0000` shape |
| `show` | `<ref>` |
| `diff` | `--cached/--staged`, `--name-only`, `--name-status`, `--stat`, `--diff-filter=ACMR`, `-q/--quiet`, `<ref>` (workdir vs ref), `<from> <to>`. Default output is the unified diff (`diff --git`, `index`, `---`/`+++`, `@@` hunks) matching `git diff --no-color` byte-for-byte on mode 100644 files; binary files get `Binary files differ` (NUL-byte heuristic). `--stat` emits `<file> | <total> ±±±±` rows + `<N> files changed, <X> insertions(+), <Y> deletions(-)` summary |
| `branch` | (list), `<name>` (create), `-d/-D <name>`, `-m <old> <new>`, `--show-current` |
| `checkout` | `<ref>`, `-b <new>`, `-f`, `-- <files...>` |
| `merge` | `<branch>`, `--no-ff`, `--ff-only`, `-m <msg>`, `--abort`, `-X/--strategy-option=ours\|theirs`, `--allow-unrelated-histories`, `--no-edit` |
| `tag` | `<name>`, `-a -m <msg>`, `-d <name>`, `-f`, `-l`, `--points-at <ref>` |
| `show-ref` | `[--heads] [--tags] [-d/--dereference]`. No flags = heads + tags + remotes (matches git default). `-d` adds the peeled `^{}` line for annotated tags |
| `for-each-ref` | `[--count=<n>] [--sort=<key>]... [--format=<fmt>] [<pattern>...]`. Lists refs sorted, capped by `--count`, rendered through `--format` (`%(refname[:short\|:strip=n])`, `%(objectname[:short[=n]])`, `%(objecttype)`, deref `%(*objectname)`/`%(*objecttype)`, `%%`). Sort keys: `refname` (default), `v:refname`/`version:refname` (git versioncmp). **Lazy**: names are sorted as strings and only the survivors after `--count` resolve oids/objects — `--sort=-v:refname --count=1 refs/tags/'v*'` reads exactly one ref regardless of tag count |
| `describe` | `[--exact-match] [--tags] [--abbrev=<n>] [<ref>]`. Default emits `<tag>-<N>-g<short>` (or just `<tag>` when ref is the tagged commit). `--exact-match` only matches annotated tags by default (matches git); `--tags` opts in to lightweight too |
| `pack-refs` | `--all` (default behavior), `--prune` (always on) |
| `reset` | `--soft`, `--mixed`, `--hard`, `<ref>`, `-- <files...>` |
| `clone` | `<url>`, `-b/--branch <ref>`, `--depth <n>`, `--single-branch`, `--no-checkout` |
| `fetch` | `[<remote>]`, `--prune`, `--tags`, `--depth <n>` |
| `pull` | `[<remote>] [<branch>]`, `--ff-only` |
| `push` | `[<remote>] [<ref>]`, `--force`, `--delete` |
| `remote` | `-v`, `add <name> <url>`, `remove <name>` |
| `config` | `<key> [<value>]` |
| `stash` | `push` (default), `pop`, `list` |
| `rev-parse` | `<ref>`, `--short`, `--abbrev-ref` |
| `rev-list` | `<ref>` or `<A>..<B>` (range: commits reachable from B not from A), `--all`, `--reverse`, `-n/--max-count <n>`, `--count` (print just the number) |
| `merge-base` | `--is-ancestor <maybeAncestor> <descendant>` (only). Returns empty string on yes; on no, throws an `Error` with `.exitCode = 1` (same shape as `diff --quiet`) so a shell strategy can map to native git's exit-1-empty-stderr without parsing message strings. Bad refs / IO failures throw without `.exitCode`, distinguishing "negative answer" from "real failure" |
| `ls-files` | — |
| `ls-tree` | `[-r] [-t] [--name-only] [<tree-ish>] [<path>...]`. Reads commit/tree **objects**, never the index — immune to a stale `.git/index`. `<tree-ish>` accepts `HEAD`, branch/tag, commit SHA, or tree SHA (commits/tags peeled automatically). Throws on an unborn HEAD or bad ref |
| `gc` | `--quiet`, `--aggressive` (no-op), `--prune=<date>` (always behaves as `--prune=now`) |

Unsupported subcommands (`rebase`, `cherry-pick`, `bisect`, `reflog`, `submodule`, `worktree`, `blame`) throw a clear error rather than silently misbehaving.

### Output format

`exec()` returns a string mimicking real git CLI output:

```
> git commit -m "msg"
[main 4a1b2c3] msg

> git status --porcelain
 M src/index.ts
?? new-file.txt

> git log --oneline
4a1b2c3 msg
0f1e2d3 init
```

If you need structured data instead, call the underlying methods directly: `await mg.commit('msg')` returns the SHA; `await mg.status()` returns `FileStatus[]`; etc.

## Programmatic API

The class-based API is fully typed and remains the preferred entry point when you need structured results.

### Setup

| Method | Description |
|--------|-------------|
| `new MemoryGit(name?, options?)` | Creates instance with isolated volume. `{tracksDiskSnapshot, lazy, maxLogEntries}` — `lazy:true` defers reading file contents until first access (see [Lazy mode](#lazy-mode)); `maxLogEntries` caps the operation log (ring buffer, default unbounded — set a bound on long-lived/pooled instances) |
| `setAuthor(name, email)` | Sets commit author |
| `config(key, value?)` | Get/set git config (special-cases `user.name`/`user.email` to sync with author) |
| `init(options?)` | Initializes empty repo. `{defaultBranch, bare}` |
| `loadFromDisk(path, options?)` | Loads existing repo. `{respectGitignore, nestedGitignore, ignore, skipSnapshot, stageWorkingTree}` — builds a fingerprint snapshot by default so subsequent `flush` calls are incremental; pass `skipSnapshot:true` to skip the hash pass. Loading a **committed** checkout leaves `add('.')` a no-op until you write in memory (writes are tracked automatically, including via `toJustBashFs`); a fresh import (unborn HEAD) seeds the whole tree. Pass `stageWorkingTree:true` to force `add('.')` to stage a loaded worktree with pre-existing unstaged/untracked changes |
| `clone(url, options?)` | Clones remote. `{branch, depth, singleBranch, noCheckout}` |
| `clear()` | Resets memory state |
| `flush(targetPath?, options?)` | Syncs memory to disk. `{clean, force}` — incremental by default; `force:true` does a full rewrite |
| `isDirty()` | `true` if there is in-memory state not yet persisted to disk — working-tree writes **or** internal `.git/` writes (commits, tags, refs, index) from any operation. O(1). Use it to decide *when* to `flush()` under the write-behind model: it flips `true` the instant a commit or tag is created (even with no working-tree change) and back to `false` after `flush()`. Does **not** auto-flush |
| `getDirtyPaths()` | The repo-relative paths behind `isDirty()` (e.g. `src/app.tsx`, `.git/refs/tags/v0.0.1`). Snapshot copy, for logging/observability |

### Files

| Method | Description |
|--------|-------------|
| `writeFile(filepath, content)` | Writes file |
| `readFile(filepath, options?)` | Reads file. Default utf-8 → string; `{encoding: null}` → Buffer (binary-safe) |
| `deleteFile(filepath)` | Deletes file |
| `fileExists(filepath)` | Checks existence |
| `listFiles(dir?, includeGit?)` | Lists files in working tree |
| `rename(old, new, options?)` | `git mv`. `{force}` |

### Staging and commits

| Method | Description |
|--------|-------------|
| `add(filepath, options?)` | Stage. `filepath`: string \| string[] \| `'.'`. `{all, update}` |
| `remove(filepath, options?)` | `git rm`. `{cached}` keeps the working file |
| `commit(message, options?)` | Returns SHA. `{amend, allowEmpty, all, author, date}` |
| `status()` | Returns `FileStatus[]` |
| `statusText(options?)` | Porcelain/short/branch text format |
| `diff(options?)` | `{cached, fromRef, toRef, paths, filter}` — `filter` accepts `'A'\|'C'\|'D'\|'M'\|'R'\|'T'\|'U'\|'X'\|'B'` codes (`git diff --diff-filter`) |
| `diffText(options?)` | `{nameOnly, nameStatus}` |
| `hasDiff(options?)` | Boolean shape of `git diff --quiet` — `true` iff `diff(options)` would return any entries |

### History

| Method | Description |
|--------|-------------|
| `log(options?)` | `{depth, ref, author, since, until}`. Returns `CommitInfo[]` (now also carries `parents`, `tree`, `committer`, and tz offsets so log/show can emit byte-identical git-style dates and `Merge:` lines) |
| `logText(options?)` | `{oneline, format}`. `format` expands `git log --format=<fmt>` placeholders (`%H`/`%h`/`%s`/`%an`/`%ae`/`%ad`/`%ai`/`%at`/`%cn`/`%ce`/`%cd`/`%ct`/`%T`/`%t`/`%P`/`%p`/`%b`/`%B`/`%n`/`%%`) one line per commit |
| `showRefs(options?)` | `{heads, tags, remotes}` (any unset ⇒ all). Returns `{oid, ref, peeled?}` per ref. Backs `git show-ref` |
| `forEachRef(options?)` | `{patterns, sort, count, format}`. Returns one formatted line per selected ref. Backs `git for-each-ref`. Sorts ref *names* (strings) and resolves oids/objects only for the survivors after `count` — `{sort:['-v:refname'], count:1, patterns:['refs/tags/v*']}` reads exactly one ref on a repo with thousands of tags |
| `describe(ref?, options?)` | `{tags, abbrev}`. Walks parents from `ref` to the nearest tag, emits `<tag>-<N>-g<short>`. `N` is computed via `revListCount(tag..ref)` for merge-DAG accuracy. `--tags` includes lightweight tags |
| `show(ref?)` | Commit metadata + changed files |
| `resolveRef(ref?, options?)` | `git rev-parse`. `{short, abbrevRef}`. Accepts short OIDs |
| `revList(options?)` | `{all, reverse, maxCount, ref, range}` — `range:{from,to}` lists commits reachable from `to` but not from `from` (mirrors `git rev-list A..B`) |
| `revListCount(options?)` | Just the count of `revList(options)`. Pair with `range` for "how many commits is FETCH_HEAD ahead of HEAD?" in one call |
| `isAncestor(maybeAncestor, descendant)` | `true` iff `maybeAncestor` is reachable from `descendant` (reflexive). Mirrors `git merge-base --is-ancestor` |
| `readFileAtRef(filepath, ref?, options?)` | `{encoding: 'utf8' \| 'buffer'}` |
| `listTrackedFiles(ref?)` | `git ls-tree -r` — returns just the paths at `ref` |
| `lsTree(options?)` | `{treeish, recursive, nameOnly, showTrees, pathspecs}`. Reads commit/tree **objects** (never the index), so it's immune to a stale `.git/index`. Returns `LsTreeEntry[]` (`{mode, type, oid, path}`) in native-git order. Throws on unborn HEAD / bad ref. Backs `git ls-tree` |
| `getChangedFiles(fromRef, toRef?, options?)` | Diff two refs. `{filter}` |
| `reset(ref?, options?)` | `{mode: 'soft' \| 'mixed' \| 'hard', paths}` |
| `resetFile(filepath)` | Resets single file to HEAD |

### Branches

| Method | Description |
|--------|-------------|
| `createBranch(name)` | Create |
| `deleteBranch(name, options?)` | `{force}` — without force, refuses to delete unmerged branches |
| `renameBranch(old, new)` | `git branch -m` |
| `checkout(ref, options?)` | `{createBranch, force, files}` |
| `listBranches()` | Returns `BranchInfo[]`. Cached per instance with in-flight dedup (see [Concurrency](#concurrency-and-caching)); invalidated on any branch create/delete/rename/checkout |
| `branchText()` | `git branch` text format (current branch prefixed with `*`) |
| `currentBranch()` | Returns current branch name. Cached per instance with in-flight dedup; invalidated when HEAD moves to another branch |
| `merge(branch, options?)` | `{noFastForward, fastForwardOnly, message, strategy, allowUnrelatedHistories, author, committer, date}`. `strategy: 'ours'\|'theirs'` resolves every conflict by keeping that side wholesale (mirrors `git merge -X ours\|theirs`). `{author, committer, date}` pin the merge commit's identity for byte-identical OID reproduction vs `git merge` under fixed `GIT_*_DATE` |
| `abortMerge()` | `git merge --abort`. Restores the working tree to its pre-merge state and clears `MERGE_HEAD`/`MERGE_MSG`/`MERGE_MODE`. Throws if no merge is in progress |

### Tags

| Method | Description |
|--------|-------------|
| `createTag(name, refOrOptions?, options?)` | Lightweight or annotated. `{ref, annotated, message, force, tagger, date}`. For annotated tags, `{tagger, date}` pin the tag-object OID — pass `tagger.timezoneOffset` explicitly (commonly `0`) for byte-identical reproduction vs `git tag -a` under fixed `GIT_COMMITTER_DATE`; lightweight tags carry no tagger and are unaffected |
| `listTags(options?)` | Tag names. `{limit, offset, reverse}` for pagination |
| `deleteTag(name)` | `git tag -d` |
| `describeExact(ref?, options?)` | `git describe --exact-match --tags`. `{skipPeel}` skips the per-loose-tag `readTag` peel for ~5× faster cold path on lightweight-only repos |
| `tagsPointingAt(ref?, options?)` | `git tag --points-at`. `{limit, skipPeel}` |
| `showTagRefs(options?)` | Returns `{tagName, refOid, commitOid}` per tag. `refOid` is what the ref *itself* stores (tag-object OID for annotated, commit OID for lightweight — what `git show-ref` emits by default); `commitOid` is the peeled commit. `{limit, reverse, skipPeel}` — paginated listings short-circuit and only resolve the N tags requested instead of scanning every tag |
| `packRefs()` | `git pack-refs --all`. Coalesces every loose `refs/{heads,tags,remotes}/*` into a single `.git/packed-refs` (annotated tags get peeled `^<commit>` lines inline). On a repo with thousands of loose tags this turns the cold path of any tag-iterating call from O(N) file reads into a single ~80 KB read. Call from `flush` (use `flush({clean:true})` so the loose files actually disappear from disk) or a periodic maintenance job — packing on every write rebuilds the whole file |

### Remotes

| Method | Description |
|--------|-------------|
| `addRemote(name, url)` | Add |
| `deleteRemote(name)` | Remove |
| `listRemotes()` | `RemoteInfo[]` |
| `fetch(options?)` | `{remote, prune, tags, depth, singleBranch, ref}` |
| `pull(options?, branch?)` | `{remote, branch, fastForward, fastForwardOnly}` |
| `push(options?, ref?)` | `{remote, ref, remoteRef, force, delete}` |

### Stash

| Method | Description |
|--------|-------------|
| `stash()` | Saves workdir changes, restores to HEAD |
| `stashPop()` | Restores most recent stash |
| `stashList()` | Stash count |

### Maintenance

| Method | Description |
|--------|-------------|
| `gc(options?)` | In-memory `git gc`: repacks every reachable object into a single new pack and prunes loose copies. `{consolidatePacks, includeRemoteRefs, includeTags}` — `consolidatePacks` (default `true`) rolls existing packs into the new one too. Returns `GcResult` with reachable/loose/pack counts. Run before `flush({clean: true})` to propagate the cleanup to disk. See [Garbage collection](#garbage-collection) for the workflow and limitations |

### Observability — the audit trail

Every method records an entry in the operation log. This is what makes MemoryGit useful as an agent harness: you always know exactly what the agent did.

| Method | Description |
|--------|-------------|
| `getOperationsLog()` | All recorded operations with timestamps, params, results |
| `getOperationsStats()` | Aggregated counts by operation, success/failure |
| `exportOperationsLog()` | JSON string suitable for storing or feeding back to a model |
| `clearOperationsLog()` | Reset the log |
| `onOperation(cb)` | Subscribe to log entries as they're recorded; returns an unsubscribe function |
| `getMemoryUsage()` | Resident bytes / file count via a cheap stat walk (no Volume clone). Includes a `breakdown` of working tree vs `.git`, and pack / loose / `looseObjects` within `.git` — use it to see where an instance's memory goes and when to `gc()` |
| `getRepoInfo()` | Repo summary |

```typescript
const unsub = mg.onOperation(op => {
    tracing.record(op.operation, { ok: op.success, ms: 0, err: op.error });
});
// ...later
unsub();
```

Listener errors are swallowed (set `MEMORY_GIT_DEBUG=1` to log them); they will never break a git op.

### Streaming output

Long results (a 1000-commit log, every tracked path) don't have to be buffered.
`execStream()` yields one logical line at a time, lets you break early, and
respects an `AbortSignal`.

```typescript
for await (const line of mg.execStream('git log --oneline')) {
    if (shouldStop()) break;
    process.stdout.write(line + '\n');
}
```

`log`, `ls-files`, `ls-tree`, and `rev-list` yield item-by-item; other
subcommands compute the full output then yield line-by-line.

### Cancellation

`exec()`, `execStream()`, `clone()`, `fetch()`, `pull()`, and `push()` accept a
standard `AbortSignal`. On abort, the awaited promise rejects with a Web-standard
`AbortError` (`DOMException`).

```typescript
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);
try {
    await mg.clone(url, { signal: ctrl.signal });
} catch (e) {
    if ((e as DOMException).name === 'AbortError') {
        // request was cancelled; mutation, if any, is left as-is
    }
}
```

Any state mutated before abort stays mutated — rollback (e.g. `mg.clear()` and
retry) is the caller's responsibility.

### Integration with just-bash

The `memory-git/adapters/just-bash` sub-export wraps a `MemoryGit` instance in
[just-bash](https://www.npmjs.com/package/just-bash)'s `IFileSystem` interface,
so a single in-memory Volume can serve both git ops and shell ops. Install
`just-bash` only if you use this sub-export.

```typescript
import { MemoryGit } from 'memory-git';
import { toJustBashFs } from 'memory-git/adapters/just-bash';
import { Bash } from 'just-bash';

const mg = new MemoryGit();
await mg.init();

const bash = new Bash({ fs: toJustBashFs(mg) });
await bash.run('echo "hello" > /repo/greet.txt');

await mg.add('greet.txt');
await mg.commit('add greeting');
```

Pass `onWrite` to be notified after every mutating call — useful for tracking
dirty paths for write-behind flushing:

```typescript
import { MemfsBackedFs } from 'memory-git/adapters/just-bash';

const dirty = new Set<string>();
const fs = new MemfsBackedFs(mg.volume, {
    onWrite: (path, op) => { dirty.add(path); }
});
```

If you need the raw Node-fs-compatible interface for other libraries, use
`mg.volume` directly — it returns the same in-memory `IFs` object.

## Patterns for agent workflows

### Speculative work, conditional persist

```typescript
const mg = new MemoryGit();
await mg.loadFromDisk('./repo');

await mg.exec('git checkout -b speculative');
await agent.makeChanges(mg);          // agent reads/writes via mg
await mg.exec('git add .');
await mg.exec('git commit -m "agent attempt"');

const ok = await verify(mg);          // run tests, lint, whatever
if (ok) await mg.flush();             // only NOW does it touch real disk
```

### Parallel attempts in isolation

```typescript
const attempts = await Promise.all(
    ['claude', 'gpt', 'haiku'].map(async name => {
        const mg = new MemoryGit(name);
        await mg.loadFromDisk('./repo');
        await agent[name].run(mg);
        return { name, log: mg.getOperationsLog(), passed: await verify(mg) };
    })
);
// Pick the winner, flush only that one.
```

### Bypass slow storage (EFS / NFS / network mounts)

```typescript
// Repo lives on EFS. Cloning or running git there would be glacial.
const mg = new MemoryGit();
await mg.loadFromDisk('/mnt/efs/repo', { ignore: ['node_modules'] });

// All git ops happen in RAM — no per-object round-trip to EFS
await mg.exec('git checkout -b release/2026.05');
await mg.exec('git log --oneline -n 50');
await mg.exec('git diff main --name-only');

// Flush only the working tree changes back; .git/ never touches EFS again
await mg.flush('/mnt/efs/repo');
```

A typical `.git/` on a real project has 5k-50k tiny object files. On EFS that's 5k-50k × ~10ms = unusable. In memory it's a `for` loop.

### Replay / summarize the agent's session

```typescript
const summary = mg.getOperationsStats();
// { total: 47, successful: 45, failed: 2, byOperation: { commit: { ... } } }

const fullLog = mg.exportOperationsLog();  // JSON
```

## Loading and persisting

```typescript
const mg = new MemoryGit();

// By default, loadFromDisk respects every .gitignore in the tree (root + nested).
// The repo's own .git/ is always loaded regardless of any pattern.
await mg.loadFromDisk('./existing-repo');

// You can still add explicit patterns on top, or opt out entirely:
await mg.loadFromDisk('./existing-repo', {
    ignore: ['*.pem', 'secrets/'],   // added to whatever .gitignore says
    nestedGitignore: false,          // only honor the root .gitignore
    // respectGitignore: false,      // disable gitignore entirely
});

// ... do work ...

await mg.flush();                       // back to original path
await mg.flush('./output-dir');         // or somewhere else
```

### Lazy mode

Default `loadFromDisk` reads every working-tree file and the entire `.git/` into memory up front. For repos where you only need a tiny slice — an agent that reads HEAD plus one or two paths, a CI probe that runs `git log` once and exits — that's a lot of pointless I/O.

Pass `{ lazy: true }` to the constructor and `loadFromDisk` only walks the tree to learn what exists (one `stat` per working-tree file, none for content-addressed git objects, no `read`). File bytes are pulled in the first time anything reads them through the wrapped fs — `readFile`, `git.log`, `git.checkout`, etc. Anything you never touch stays on disk.

```typescript
const mg = new MemoryGit('agent', { lazy: true });
await mg.loadFromDisk('./big-repo');   // stat-only walk, near-zero bytes in RAM
await mg.log({ depth: 1 });            // faults in only the refs + packs it needs
await mg.readFile('src/util.ts');      // faults this one file
await mg.flush();                       // writes only what changed in memory
```

Materialized files participate in the normal disk snapshot, so `flush()` stays incremental — untouched lazy files are never re-written. Deleting a still-lazy file in memory (`mg.deleteFile('x')`) produces a tombstone that `flush()` propagates as a disk-side delete.

**Trade-offs, explicitly:**

- **Pack files are all-or-nothing.** A `pack-*.pack` is loaded whole the first time any object inside is read — there's no seek inside memfs. You save on packs you never touch; you don't save *within* a pack.
- **Operations that iterate the working tree force-materialize everything they visit.** `add('.')`, `status`, `statusMatrix` walk every tracked file. If your workflow ends with one of those, lazy doesn't help you. Lazy shines on random-access reads.
- **`flush({ force: true })` does not refault.** A force-flush rewrites only what's currently in memory — lazy files stay where they are on disk. If you need a true bit-for-bit rewrite of the destination, don't use lazy mode.
- **External mutation between load and read.** Lazy holds onto the `realPath` it captured at load time. If something else deletes or replaces that file on disk before you fault it in, the read surfaces `ENOENT`. Call `loadFromDisk()` again to reconcile.
- **Unread git objects have no size until asked.** Loose objects and pack files are content-addressed, so the walk records them without a `stat` — they're most of the files in a repo that commits often, and each `stat` is a round trip on a network filesystem. `stat`/`lstat` of a still-lazy object answers type checks (`isFile()`, `exists`) from the index; reading `size` or a timestamp stats the file on disk once, synchronously, and throws `ENOENT` (dropping the entry) if it has vanished.

Lazy and `tracksDiskSnapshot` compose: the wrapper feeds the snapshot a fingerprint for each file as it materializes, so the next `flush({ clean: true })` only writes what actually changed.

### Incremental sync

**Since 3.4, incremental sync is the default.** `loadFromDisk` builds a per-file fingerprint (size + mtime + sha1) during the load, and `flush` uses it to write only files whose content actually changed.

```typescript
const mg = new MemoryGit();

// First call: full read, plus build the fingerprint snapshot.
await mg.loadFromDisk('./repo');

// Later — pick up only the files that changed on disk (size/mtime pre-filter):
await mg.loadFromDisk('./repo');

// ...mutate a few files in memory...
await mg.writeFile('src/a.ts', '// edited');

// Only files whose content hash differs from the snapshot are written.
// Use clean:true to also delete files removed from memory.
await mg.flush('./repo', { clean: true });
```

The snapshot is treated as authoritative for the destination — we don't stat disk on every file. External writes between flushes are invisible until you `loadFromDisk()` again. This is the trade-off that makes it cheap on EFS/NFS, where one stat per file dominates the cost.

#### Opting out

You almost never want to opt out — the foot-gun this default is meant to prevent is asymmetric: forgetting `skipSnapshot` on load and then calling `flush` means flushing against an empty baseline, which silently rewrites every file (including `.git/objects/*`, which git leaves mode `0444` → `EACCES`). Three escape hatches, in order of granularity:

```typescript
// Per-call, on load: skip the hash pass for this load.
await mg.loadFromDisk('./repo', { skipSnapshot: true });

// Per-call, on flush: force a full rewrite (also invalidates the snapshot).
await mg.flush('./repo', { force: true });

// Per-instance: disable snapshot bookkeeping entirely (no warning on flush).
const mg = new MemoryGit('agent', { tracksDiskSnapshot: false });
```

If `loadFromDisk` runs with `skipSnapshot:true` and `flush` is then called without `force:true`, MemoryGit logs a warning and falls back to a full rewrite — surfacing the foot-gun instead of silently doing expensive (and often failing) writes.

The legacy `{incremental: true}` flag on both methods is accepted as a no-op alias of the new default so existing callers keep working.

## Garbage collection

Agent sessions that churn through speculative commits, branches, and resets pile up loose objects in `.git/objects/`. `mg.gc()` repacks every reachable object into a single packfile *in memory* and deletes the loose copies; `flush({clean: true})` propagates the cleanup to disk.

**The reason this exists is slow filesystems.** Native `git gc` does thousands of metadata ops in place against `.git/objects/` — fast on local SSD, brutal on EFS/NFS/networked dev-container volumes where every loose-object unlink is a round-trip. The MemoryGit pipeline (`loadFromDisk → gc → flush({clean:true})`) collapses that into one bulk read of small files, an in-RAM repack, and one batched write of the new pack plus a delete sweep. On local SSD native `git gc` is faster end-to-end (~3×); on EFS/NFS the equation inverts.

```typescript
const mg = new MemoryGit();
await mg.loadFromDisk('./repo');

// ... agent does work, accumulates loose objects ...

const result = await mg.gc();
// { reachableObjects: 1500, looseDeleted: 1500, packsRemoved: 0,
//   packFilename: 'pack-<sha>.pack', packSizeBytes: 3091382 }

await mg.flush(null, { clean: true });
// The `clean: true` is required: gc is a deletion event, and incremental
// flush only writes — it doesn't remove disk files unless asked to.
```

Reachability is computed from local branches, remote-tracking branches, tags, and HEAD. Unreachable objects (e.g. commits orphaned by `reset --hard`) are dropped — there is no reflog grace period, so the effective behavior is `git gc --prune=now`.

`{consolidatePacks: true}` (the default) rolls existing packs into the new one and deletes the old `.pack`/`.idx`/`.rev`/`.mtimes`/`.bitmap` files. The new pack remains content-addressed, so re-flushing it over an already-packed disk repo is a no-op for any pack that hasn't changed.

**Limitations:**
- `packObjects` buffers the entire new pack in memory before writing. Peak RAM during `gc()` is roughly the packed size of the repo.
- No custom delta compression — the resulting pack may be larger than what `git gc` produces natively. Re-running `git gc` on disk after a flush re-packs with deltas if size matters.
- Submodule pointers are not followed (their history lives in another repo).

## Concurrency and caching

A MemoryGit instance is typically shared by everything working on one repo — a route handler firing `Promise.all([mg.status(), mg.diff(), mg.currentBranch(), mg.listBranches()])`, a worker servicing concurrent requests, an agent fanning out reads. Several read paths resolve the same underlying state (HEAD, the branch list, the tag→commit map), and on lazy mode / slow filesystems each resolution is a disk round-trip. To keep that cheap, those resolvers are memoized per instance with **in-flight deduplication**: concurrent callers share one load instead of each starting their own, and the result is reused for the instance lifetime until a write invalidates it.

| Cached resolver | Backs | Invalidated by |
|---|---|---|
| current branch (`HEAD`) | `currentBranch()`, `resolveRef('HEAD', {abbrevRef})`, `reset`, `statusText --branch`, `listBranches` | `checkout`, `createBranch`/`deleteBranch`/`renameBranch`, `init`, `clone`, `clear`, `loadFromDisk` |
| local branch name list | `listBranches()` | same as above |
| tag → commit OID map | `describeExact`, `tagsPointingAt`, `showTagRefs` | `createTag`/`deleteTag`, `init`, `clone`, `clear`, `loadFromDisk` |

Ref *moves* that don't change names or where HEAD points — `commit`, `reset`, `merge` — deliberately don't invalidate the branch caches: the branch you're on and the set of branch names are unchanged, only the commit a ref points at moves.

The **status matrix** — the whole-tree walk + blob hashing behind `status()`, `diff()`, `statusText()`, the empty-commit guard, and `reset --mixed` — uses a different policy. Its result tracks the working tree, which changes on every write, so it is never retained: only callers that overlap *in flight* (the same `Promise.all` burst) share one walk; the next call after settlement always rebuilds. So a concurrent `[status, diff, statusText]` does one tree walk instead of three, while a read issued after an awaited write still sees fresh state.

This is transparent — there's no API to opt in or out, and correctness is preserved because every mutating method drops the affected caches (and the status matrix is never cached past the in-flight window). The only caveat: if you bypass the public API and mutate refs directly through `mg.fs` / `mg.volume`, call the relevant operation through MemoryGit instead so the caches stay coherent.

```typescript
// One Promise.all burst → one .git/HEAD read + one branch-list read,
// not one per call. Subsequent reads are served from memory until a
// branch/HEAD write.
const [status, branch, branches] = await Promise.all([
  mg.status(),
  mg.currentBranch(),
  mg.listBranches(),
]);
```

## Memory footprint on Node 26+

Node v26 introduced a regression where `new Blob([buffer]).stream()` pins its
input buffer in V8 *eternal handles* and never releases it. isomorphic-git uses
exactly that call to compress every object it writes (`add` / `commit` / `merge`
/ `clone`), so on Node 26 a long-lived process leaks roughly one object-sized
buffer per write. The symptom is **multi-GB RSS while the V8 heap and
`getMemoryUsage()` stay tiny** — the retained memory is native (off-heap) and
invisible to the volume accounting. Node 20/22/24/25 are unaffected, and reads
never trigger it (the inflate path always uses pako).

MemoryGit works around this automatically: on the affected Node versions it
makes isomorphic-git fall back to [pako](https://github.com/nodeca/pako)
(pure-JS, no leak) for compression. The workaround primes isomorphic-git's
feature detection once at startup (`init` / `loadFromDisk` / `clone` await it)
and leaves `globalThis.CompressionStream` untouched for the rest of your process.

Override via the `MEMORY_GIT_COMPRESSION` env var:

| Value | Effect |
|---|---|
| _unset_ (default) | Auto: force pako only on Node major ≥ 26 |
| `pako` | Force pako on any Node version |
| `native` | Never touch compression (opt out — keeps native `CompressionStream`) |

`primeSafeCompression()` and `shouldForcePako()` are exported if you need to
prime manually (e.g. before bypassing the standard entry points) or to inspect
the decision.

## TypeScript

All option and result types are exported:

```typescript
import {
    MemoryGit,
    // Options
    InitOptions, AddOptions, CommitOptions, RemoveOptions,
    DeleteBranchOptions, CheckoutOptions, MergeOptions,
    CreateTagOptions, ResetOptions, RenameOptions,
    CloneOptions, FetchOptions, PullOptions, PushOptions,
    LogOptions, ResolveRefOptions, DiffOptions, GcOptions,
    // Results
    CommitInfo, FileStatus, BranchInfo, RemoteInfo,
    TagRef, ChangedFile, DiffEntry, MergeResult,
    ShowResult, RevListOptions, ResetMode, GcResult,
    MemoryUsage, RepoInfo, Author, OperationLogEntry, OperationStats
} from 'memory-git';
```

## Migration from v1 to v2

**Breaking change in v2:** each instance now has its own isolated filesystem volume. In v1, all instances shared a global memfs volume, causing interference.

```typescript
// v2 — instances are fully isolated
const g1 = new MemoryGit('a');
const g2 = new MemoryGit('b'); // independent volume, no interference
```

## Performance

Run `pnpm run benchmark` to reproduce.

| Workload | Git CLI (`execSync`) | MemoryGit | Result |
|---|---|---|---|
| Process spawn overhead | ~12-13ms / call | none | — |
| `exec()` parsing overhead (tokenize + flag-parse) | — | ~3-6µs / call | negligible |
| 500 small commands (status / log / rev-parse / branch --show-current / diff --quiet) | 6196ms | 68ms | **90× faster** |
| 100 sequential commits | 3542ms | 181ms | **19.5× faster** |
| 200 status / write / add / commit / log cycles | 15107ms | 1013ms | **14.9× faster** |
| 50× repeated `git log` | 711ms | 39ms | **18.2× faster** |
| Init + 50 files + commit + branch + merge | 965ms | 104ms | **9.2× faster** |
| End-to-end `gc` on 500-commit repo (1500 loose objects): native `git gc` in place vs `loadFromDisk + mg.gc() + flush({clean:true})` | 393ms | 1159ms (116 load + 793 gc + 250 flush) | Native wins ~3× on local SSD. Ratio inverts on EFS/NFS — see below |
| `loadFromDisk` on 500-file repo (~1MB workdir + `.git/`) | eager: 45.5ms / ~1.77 MB in RAM | lazy: 11.0ms / near-zero in RAM (dir skeleton only) | **~4× faster load** + memory scales with what you actually read, not repo size. First read of any path pays its disk cost — see [Lazy mode](#lazy-mode) |
| Concurrent ref reads — one `Promise.all` of 8× `currentBranch` + 8× `listBranches` | — | 16 logical reads → **2** disk-eligible reads | **8× fewer round-trips**; a 500-read warm session collapses to **0** reads — see [Concurrency](#concurrency-and-caching) |

Five takeaways:

1. **`exec()` parsing is free.** It adds 3-6µs to a call that previously cost ~12ms via subprocess. The string-API ergonomics carry no real cost.
2. **The agent-loop pattern is the killer use case.** Many small read-style calls amortize JS-level overhead and skip the per-call spawn tax — **>100× faster end-to-end**.
3. **Multi-file commits are also faster.** A dirty-set tracker (writeFile marks files as needing re-stage; `add('.')` only touches those) means write-heavy workloads beat the C binary on local SSD too.
4. **Lazy mode decouples startup cost from repo size.** When you only need a slice of the repo (HEAD + one path, one `git log`), `{ lazy: true }` skips the full-tree read and faults files in on first access.
5. **Concurrent ref reads coalesce.** `currentBranch()` / `listBranches()` (and the tag lookups behind `describeExact` / `tagsPointingAt`) share per-instance caches with in-flight dedup, so a route handler's `Promise.all([...])` burst issues one `.git/HEAD` + one ref read instead of N, and stays cached until the next branch/HEAD write.

**The gap widens dramatically on slow filesystems.** Git's `.git/objects/` is small-file-heavy by design (one file per blob, tree, and commit), which is the worst-case access pattern for EFS, NFS, and overlay/networked dev-container volumes. A `git log` over a large history that runs in 50ms on local SSD can take tens of seconds on EFS — every object is a round-trip. MemoryGit keeps all that in RAM and only flushes the actual working-tree files back when you ask it to.

<details>
<summary>Benchmark machine</summary>

- Apple M4 Pro · 12 cores · 24 GB RAM
- macOS 26.3.1
- APFS on internal NVMe SSD
- Node.js v26.1.0
- memory-git v3.10, isomorphic-git v1.38.2, memfs v4.57

Numbers vary per machine; the ratios are what matter, and they grow on slower disks.

</details>

## Dependencies

- [isomorphic-git](https://isomorphic-git.org/) — pure-JS Git implementation
- [memfs](https://github.com/streamich/memfs) — in-memory filesystem
- [shell-quote](https://github.com/ljharb/shell-quote) — bash-style tokenization for `exec()`
- [mri](https://github.com/lukeed/mri) — minimal CLI flag parser for `exec()`
- [ignore](https://github.com/kaelzhang/node-ignore) — `.gitignore`-style pattern matching for `loadFromDisk`

## License

MIT
