# Validation caches: what is reused, and what always runs

HARN-49. `npm run validate` is the gate CI runs and the command every change is
checked with. Most of it is deterministic work over files that usually did not
change between two validations of the same revision; the rest is real processes
whose whole point is to observe a machine. This document says which is which,
what each cache-eligible task declares as its inputs, where the caches live, and
what was actually measured.

Turborepo does the task caching. This repository contributes declarations
(`turbo.json`), the native caches the tools already have (ESLint's content
cache, TypeScript's incremental state for the check-only program) and three
small scripts under `scripts/`. No part of this repository hashes inputs, stores
results, invalidates entries or replays work by itself; that was the point of
choosing a maintained task cache over a hand-rolled one (see
[Why Turborepo](#why-turborepo)).

## The gate as tasks

| Task                   | Cache | Declared inputs                                                                              | Outputs   |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------- | --------- |
| `format:check`         | yes   | `$TURBO_DEFAULT$` — every file git does not ignore                                           | none      |
| `lint`                 | yes   | `$TURBO_DEFAULT$` minus Markdown, `docs/`, `notes/`, `performance/`                          | none      |
| `typecheck`            | yes   | `src/**`, `tests/**`, `tsconfig*.json`, `vitest*.config.ts`                                   | none      |
| `build`                | yes   | `src/**`, `tsconfig*.json`, `scripts/build.mjs`                                              | `dist/**` |
| `test:policy:display`  | yes   | `src/**`, `tests/activity.test.ts` and what it reads                                         | none      |
| `test:policy:config`   | yes   | `src/**`, the six configuration/contract test files, and the guide, examples, scripts and root files they read | none      |
| `test:policy:loop`     | yes   | `src/**`, the four run-loop/completion policy files and what they read                        | none      |
| `test:policy:intake`   | yes   | `src/**`, the four queue/Jira/baseline-finding files and what they read                       | none      |
| `test:policy:history`  | yes   | `src/**`, the four history/review files and what they read                                    | none      |
| `test:boundary`        | **no**| `src/**`, `tests/**`, `tsconfig*.json`, `vitest*.config.ts`                                   | none stored |

Every task's row is the `turbo.json` entry of the same name; the test groups
also declare `tests/support.ts`, `tests/reviews-shared.ts` or `tests/fixtures/**`
where their files reach those helpers, `vitest.config.ts` (the layer's file list,
project settings and worker caps), and `eslint.config.js` for the group that
reads it. `package.json`, `package-lock.json`, `.gitattributes` and `.nvmrc` are
in every task's hash because Turborepo hashes the package graph and the global
dependencies it is given, and `turbo.json` itself is part of the run's
configuration hash (`npm run validate -- --dry=json` prints both).

Each policy group names its own files instead of falling back to "everything in
the checkout". A change to one test file therefore invalidates that group, the
checks that read every source file (`lint`, `typecheck`, `format:check`) and the
build if it is a source change — not every group. A change that *every* cached
task genuinely reads (a source file, the lockfile, a declared environment value,
the runtime) invalidates everything it should.

### What may be cached, and what may not

Two rules decide eligibility, and both are checkable in the repository rather
than argued case by case:

1. **A cached result has to be a function of its declarations.** Files, declared
   environment values, the observed runtime and the platform-specific cache
   directory are what an entry can be keyed on. Anything that observes a live
   machine — how long a real command took, whether a child tree ended, what
   `git` the host resolves — is not a function of the checkout, so it is not
   cacheable here.
2. **A case that starts a real process is never cached.** It belongs to the
   process-heavy layer that executes on every validation, whatever it is about.
   `tests/validation-cache.test.ts` reads the syntax of every cached group's own
   files and fails if one imports `node:child_process` or calls a process
   runner; it also checks that every test file this repository has belongs to
   exactly one layer, so a case cannot leave the cached groups and the gate at
   the same time.

The HARN-49 repair moved two files across that line. `tests/report.test.ts` and
`tests/completion-cli.test.ts` made real Git repositories — the executable,
its version and the inherited Git configuration are host state no declaration
here can bound — and were cache-eligible only because they sat in the fast
layer. They are cases of the boundary layer now
(`vitest.config.ts`, `policyFiles`), so they still run, and they still run on
every validation. No case was deleted, skipped or weakened, and no deadline
changed: the moved files keep their own per-case bounds.

### Why the boundary layer is never cached

`test:boundary` runs the process-heavy files: real Git repositories, real
command trees that must be stopped, the fixture lifecycle proof that starts
failing, timing-out and cancelling cases in a nested run, the built CLI as a
process, and the stand-in runtime. Their value is the observation of a live
machine — a deadline that expired, a child tree that ended, a directory that was
released — and HARN-48's audit is the record of how contention changes what they
observe. A replayed result would describe a machine that no longer exists, so
the task declares `"cache": false` and runs on every validation, before nothing
and after all five policy groups (`dependsOn`). `tests/validation-cache.test.ts`
fails if that ever stops being true.

Nothing else is eligible either, and nothing outside this repository is:

| Never cached                                                                      | Why                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npm run test:live` (the opt-in provider exercise)                                 | It drives a real coding agent and is not part of the gate   |
| Agent turns, Jira or GitHub writes, approvals, completion evidence                  | Foreign state that changes under the run                    |
| Supervisor and recovery lifecycle evidence, active-process checks, Jira/GitHub reads | HARN-51: always read fresh, never replayed                  |
| Target-repository commands                                                          | This is repository tooling for *this* repository            |

The cache holds task results only. No case shares a mutable Git repository, a
running process or a test workspace with another: every fixture still creates
its own throwaway directory per test (`tests/fixtures/lifecycle.ts`), and the
cache never stores or restores one.

## Inputs and invalidation

What invalidates an entry is exactly what the task declares, plus Turborepo's
global inputs. Both directions are checked, because a declaration that is too
narrow replays a result the inputs no longer support and one that is too wide
only costs a re-execution.

- **Files.** Each cached task declares the files it reads. Turborepo hashes their
  contents; a new file that a declared glob covers counts as a change, and a file
  no task declares does not. Markdown and recorded evidence are deliberately out
  of `lint`; `$TURBO_DEFAULT$` on `format:check` means the default file set, which
  is every file git does not ignore — a superset of what Prettier reads, which is
  the safe direction.
- **Files a case reads rather than imports.** A group's declaration is not only
  its import graph: `tests/config.test.ts` composes the checked-in examples and
  this repository's own `nexus.project.json`, `tests/connect-guide.test.ts` reads
  `docs/connect-a-project.md` and resolves the files and headings it links to,
  and `tests/validation-cache.test.ts` reads `turbo.json`, both `tsconfig`s, the
  ignore files and the two scripts the gate runs. Those reads are declared, and
  `tests/validation-cache.test.ts` follows the calls it can see
  (`path.join(repoRoot, …)` written entirely in literals, and read helpers handed
  a literal path) and fails when one of them is not. Reads the walk cannot see —
  a path built from a constant, or one of several literals a loop hands to a
  helper — are named by hand in that same test
  (`READS_A_WALK_CANNOT_SEE`), so adding one is a deliberate edit to the
  declarations rather than a silent hole.
- **The lockfile and manifests.** `package.json`, `package-lock.json` and
  `turbo.json` are in every task's hash, so installing different tools, changing
  a script or re-declaring the pipeline invalidates everything.
- **The runtime that executes the tasks.** `scripts/turbo.mjs` asks PATH which
  `node` and `npm` will run the tasks — the same resolution a task gets — and
  passes them as `NEXUS_VALIDATE_NODE` and `NEXUS_VALIDATE_NPM`, which
  `turbo.json` declares in `globalEnv`. A different runtime under the same
  checkout is therefore a different hash, and a runtime that cannot be observed
  stops the gate before it runs anything, because results nothing describes must
  not be produced. `.nvmrc` and `packageManager` remain the declared runtime and
  are hashed as files, but they are what *should* run: neither the wrapper nor
  npm enforces them.
- **The platform.** Turborepo's hash has no operating system or architecture in
  it (verified: the global inputs are the root key, the global files above,
  dependency hashes, declared environment values, the run's configuration and
  `engines`), so the cache *directory* is per platform and architecture instead —
  see [Where the caches live](#where-the-caches-live).
- **Git state.** Turborepo hashes file contents, not the commit. A commit of
  identical content — which is the ordinary case when the harness records a
  coding turn — does not invalidate anything; an uncommitted edit to a declared
  input does. Verified with a probe task: amending a commit without changing the
  tree kept the same task hash. No eligible task runs Git, so no Git version or
  configuration is a cache input: the cases that do are in the boundary layer.
- **Environment.** Every cached test task declares `TZ`, `LANG`, `LC_ALL`,
  `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP` and `VITEST_*`; every task declares `CI`,
  `NODE_ENV`, `NODE_OPTIONS` and the two runtime values globally. The rule for
  adding one is in [Troubleshooting](#troubleshooting): if a result can depend on
  a value, it is declared; if it cannot be declared, the task does not belong in
  the cache. No credential-shaped name is declared, and the contract test fails
  on one, so no token, key or secret is hashed, printed or stored.

The gate runs with `"envMode": "loose"`, not Turborepo's default strict mode.
Strict mode would filter the environment of the *boundary* tasks, which are
uncached — and that would change what a live process observes, including the
credential-isolation cases that check what a child did *not* inherit. Loose mode
keeps every task's environment exactly what a direct `npm test` would see, and
the declarations above remain the hash inputs for the cached tasks.

## Where the caches live

One ignored directory per checkout, `.turbo/`:

| Path                               | Written by | What it is                                                   |
| ---------------------------------- | ---------- | ------------------------------------------------------------ |
| `.turbo/cache/<os>-<arch>/`        | Turborepo  | successful task results, their logs and `dist/`               |
| `.turbo/eslint/.eslintcache`       | ESLint     | per-file lint results, keyed by content and configuration     |
| `.turbo/tsc/typecheck.tsbuildinfo` | TypeScript | incremental state for the check-only program                  |

There is no `.turbo/tsc/build.tsbuildinfo`, and there is not meant to be one: the
emitting program keeps no incremental state (see [The build](#the-build)).

`scripts/turbo.mjs` is the only way the gate invokes Turborepo. It adds
`--cache-dir=.turbo/cache/<platform>-<arch>`, which both separates the platforms
and turns off Turborepo's automatic sharing between Git worktrees, it notes the
executing runtime, and it turns telemetry and the update notifier off for the
invocation. It contains no caching logic of its own. An explicit `--cache-dir`
argument still wins, so `npm run validate -- --cache-dir=.turbo/cache/try` works.

Nothing here is shared: there is no remote cache (`"remoteCache": { "enabled":
false }`), no login, no token, no service, and no CI cache of task results. The
`.turbo/` directory is ignored by git, by Prettier and by ESLint, so a cache can
neither dirty the checkout nor change the checks that decide whether it may be
reused.

## Commands

| Command                    | What it does                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run validate`         | The gate: every task above, reusing a successful result only where the inputs are unchanged.     |
| `npm run validate:fresh`   | Clears the local caches, then runs the gate: every task executes, nothing is replayed.           |
| `npm run cache:clear`      | Removes `.turbo/` for this checkout. Never touches global configuration or another checkout.     |
| `npm test`                 | Both layers directly, without the task cache. For a quick look, not the gate.                     |
| `npm run test:policy`      | The fast layer alone, directly.                                                                  |
| `npm run test:boundary`    | The process-heavy layer alone, directly.                                                         |
| `npm run validate -- --dry` | What the gate would run, task by task, with hashes and hit/miss predictions. Nothing executes.  |

After a run, read the two lines Turborepo prints: `cache hit, replaying logs
<hash>` for a reused result, `cache miss, executing <hash>` or `cache bypass,
force executing <hash>` for work that ran, and the `Cached: n cached, m total`
summary. A reused result is never described as a newly executed test: cached
tasks are configured with `outputLogs: "new-only"`, so a hit prints its hash line
and no test output at all, and only tasks that really ran print their logs.

## Required behaviour of the tooling

- **A hit is only ever a successful result.** Turborepo stores the result of a
  task that exited zero. Failures and interrupted runs are not stored.
- **Loss or damage falls back to work.** Removing `.turbo/`, `npm ci`, a fresh
  checkout, `git clean -xdf`, or a damaged cache entry all mean a cache miss: the
  task executes. A cache that cannot be restored is never reported as a success.
- **A runtime that cannot be observed stops the gate.** The wrapper refuses to
  run rather than produce results no declaration describes
  (`tests/validation-cache-turbo.test.ts`).
- **Missing or stale build output is regenerated.** `npm run build` routes
  through `scripts/build.mjs`, which compiles the current sources into an output
  directory it emptied first and refuses to report a build without the artefact
  `npm start` runs. See [The build](#the-build).
- **Failures stay failures.** Turborepo exits nonzero when a task does, and
  `scripts/turbo.mjs` forwards that exit status unchanged, so a red gate is red.
- **Offline.** Nothing in the gate contacts a network service: telemetry and the
  update notifier are off, the remote cache is off, and a miss is a local
  execution.

## Integration

- **`npm ci`.** The Nexus setup step reinstalls dependencies before every check
  run. It replaces `node_modules/` and leaves `.turbo/` alone, so the caches
  survive an install of the same lockfile; an install that changes
  `package-lock.json` changes every task's hash, which is the correct outcome.
- **Retained workspaces.** The caches are inside the workspace, so a retained
  workspace keeps whatever its own revisions produced: an unchanged rerun reuses
  results, and a repair cycle invalidates exactly what changed.
- **Fresh checkouts and CI.** A clone has no `.turbo/`, so CI executes every
  task. CI caches npm downloads only; no task result is transported between
  machines, and `.github/workflows/ci.yml` was not changed.
- **Generated output deletion.** `dist/` is restored from the task cache on a
  hit, and rebuilt from the current sources when it is missing — in whole or in
  part — because the emitting program keeps no state that could describe a tree
  it no longer matches.
- **Several checkouts.** Each checkout has its own cache. Nothing is shared
  between them, so an operator cannot validate one revision against another's
  results.

## Why Turborepo

The requirement was content-based caching of successful, deterministic *test*
results, with per-task inputs, in a single-package repository, without building
cache machinery here.

- **Native caches alone are not enough.** ESLint caches per file and TypeScript
  incrementally, and both are enabled — but Vitest has no result cache, so "the
  policy layer already passed for these files" needs a task-level cache.
- **A hand-rolled cache is what the ticket forbids**, and it would have to
  re-implement hashing, storage, invalidation and replay: exactly the parts a
  maintained tool already gets right.
- **Nx, Bazel and a workflow engine are larger than this repository.** One
  package, ten tasks, one machine: a task cache with declared inputs, local
  storage and per-task opt-out is sufficient. Turborepo is small, is maintained,
  is a single dev dependency, works offline, and can be dropped again by
  deleting `turbo.json` and the wrapper.

`turbo` is pinned to the installed version (`2.11.2`) in `package.json` and
`package-lock.json`, so the hash inputs, the cache format and the CLI flags are
part of the reviewed revision. `packageManager` is pinned to the installed npm
(`11.11.0`) because Turborepo uses the package-manager declaration to stabilize
the package graph and the lockfile hash; `.nvmrc` continues to pin Node.

## Verified behaviour

Everything below was run in this checkout on Windows 10.0.26200 (24 logical
CPUs), Node `v24.14.1`, npm `11.11.0`, Turborepo `2.11.2`, TypeScript `6.0.3`,
ESLint `10.10.0`, Vitest `5.0.0`, Git `2.53.0.windows.2`. The measurements and
their raw transcripts are named in each row.

| What                                                        | How                                                                                     | Result                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| An unchanged rerun hits every eligible task                  | `performance/measure-windows.ps1`: the gate with the cache cleared, then unchanged       | Second run: `Cached: 9 cached, 10 total`, every eligible task replayed; `test:boundary` executed fresh |
| A task really is not executed on a hit                       | `tests/validation-cache-turbo.test.ts` (fixture records its own execution)               | Hit replays the logs; the fixture's marker file does not grow          |
| Declared inputs invalidate, undeclared files do not          | Same fixture: edit `src/input.txt`, add `notes.md`, add a file under `src/**`            | Miss after both declared changes; hit after the unrelated file         |
| A declared output comes back when it is missing              | Remove `out/**`, rerun                                                                   | Hit, output restored, task not executed                                |
| A failed task is never stored as a success                   | Run a failing fixture task twice                                                         | Both runs exit nonzero, both execute                                   |
| Interrupted work is never replayed                           | Stop a fixture task inside its work, rerun the same inputs                               | The rerun executes and produces the output                             |
| A damaged cache entry cannot become a success                | Overwrite the stored artefact, remove the output, rerun                                  | Treated as a miss and executed; exit 0 only with the output present    |
| The runtime is observed, not assumed                         | Fixture task records the values the wrapper supplied; compared with a PATH lookup        | They are the `node` and `npm` PATH resolves, and a task still sees them |
| Another runtime cannot reuse an earlier result               | Same fixture through a PATH whose `node` reports a different version                     | `cache miss, executing`; the first runtime's result is still there afterwards |
| An unobservable runtime stops the gate                       | Same fixture with a PATH that resolves no `node`                                         | Nonzero exit, the message names `node --version`, the task did not run  |
| The manifest and the lockfile are inputs                     | Fixture: change `package.json`'s version, then the lockfile, rerun                        | Miss after each; the task executes                                       |
| A relevant source edit invalidates the work it affects       | `--dry` hashes before and after an edit to `src/cli/options.ts`                          | Every one of the ten tasks changed its hash                             |
| A test-file edit invalidates one group, not all              | `--dry` hashes with one comment added to `tests/queue.test.ts`                            | That group changed, plus the checks that read every file (format, lint, type check) and the boundary task; the other four groups kept their hashes |
| A documentation edit invalidates the group that reads it     | `--dry` hashes with `docs/connect-a-project.md` edited                                   | The configuration group's hash changed; the other groups did not        |
| A declared environment value invalidates the test tasks      | `--dry` hashes with `TZ` set                                                             | The five test tasks changed their hash; the other tasks did not         |
| The native lint cache is invalidated by a configuration change | Add a rule to `eslint.config.js`, run `npm run lint`                                    | Every file re-linted; a comment in the same file did not invalidate anything |
| The native lint cache survives unchanged files               | `npm run lint` twice                                                                     | 3.35 s cold, 1.26 s warm                                                |
| Incremental type checking works                              | `npm run typecheck` twice                                                                | 3.04 s cold, 1.15 s warm — the check-only program keeps its state        |
| A full emit of `src/` is what a build costs                  | `npm run build`                                                                          | 1.81 s for 182 emitted files, no incremental state beside them           |
| A module missing from a complete `dist/` comes back          | `tests/build-guard.test.ts` (real compiler, throwaway project)                            | Exit 0 and the module is emitted again                                  |
| A module the sources no longer have does not survive         | Same test: delete a module and its import, build again                                   | The emitted module is gone; no `.tsbuildinfo` anywhere in the project    |
| A behaviour change, then the earlier revision again          | Same test: `'one'` → `'two'` → `'one'`, building each time                                | Each build's output is the revision it compiled                          |
| A compiler that succeeds without an artefact is a failure    | Same test: a project with `noEmit`                                                        | Nonzero exit, the message names `dist/cli.js`, nothing reported as built |
| A compile that failed is never reported as a build           | Same test: a type error                                                                   | Nonzero exit with the compiler's own diagnostic                          |
| A commit of unchanged content does not invalidate             | Compare `--dry` hashes before and after committing the same tree                          | Identical hashes and hit predictions                                     |
| The repository's declarations stay complete                   | `tests/validation-cache.test.ts`                                                          | Fails if a group stops declaring a file it imports or reads, if a cached group starts a process, if a test file leaves both layers, if the boundary layer becomes cacheable, or if the caches stop being ignored |

The recorded measurement is in
[performance/measure-windows.ps1](../performance/measure-windows.ps1) and its raw
output. Both runs are of commit `212aee1` with a clean working tree on this
host, in the same session, one after the other:

| Run (same revision, same host) | Turborepo summary  | Command wall | Layer detail                                              |
| ------------------------------ | ------------------ | ------------ | --------------------------------------------------------- |
| `npm run validate:fresh`       | 10 successful, 0 cached, 4 m 10.6 s | 251.81 s | every task executed; boundary 227.50 s over 37 files (802 passed, 2 skipped) |
| `npm run validate`             | 10 successful, **9 cached**, 3 m 52.4 s | 232.96 s | every eligible task replayed; `test:boundary` executed fresh (231.85 s) |

The gate is 1,381 passed and 2 skipped in that fresh run: the policy layer's 579
cases over its five groups (122 display, 142 config, 24 loop, 160 intake, 131
history, about 8.8 s of Vitest time together) and the boundary layer's 802 cases
plus the two pre-existing platform skips over 37 files.

Files: [fresh metadata](../performance/harn-49-validation-fresh.txt) and
[transcript](../performance/harn-49-validation-fresh-detail.txt),
[cached metadata](../performance/harn-49-validation-cached.txt) and
[transcript](../performance/harn-49-validation-cached-detail.txt), and the
[cleanup inventory](../performance/harn-49-validation-cached-cleanup.txt) — the
script fails if either run leaves a fixture directory or a Node/Git/cmd/taskkill
process identity behind, and both runs passed that check.

The invalidation comparisons are in
[performance/harn-49-invalidation.txt](../performance/harn-49-invalidation.txt):
the ten gate tasks' hashes from `--dry=json`, before and after one probe at a
time, each probe reverted and the tree checked clean again. A documentation edit
changed `test:policy:config` (and, through it, `test:boundary`, whose hash
includes its dependencies) while the other four groups kept theirs; a test-file
edit changed only its own group; a declared environment value changed the five
groups and nothing else; a source edit and another executing runtime changed
every task.

The earlier round's repair-cycle transcripts — the gate after a source edit and
after the revert, with the summary between them
([performance/harn-49-repair-cycle.txt](../performance/harn-49-repair-cycle.txt)
and the two transcripts beside it) — stay where that round recorded them; the
invalidation tables above are this round's, and they cover the same property
with one probe per declared input rather than by editing a source file.

The delivered revision (`f135055`) was then validated with `npm run
validate:fresh` once more, from a clean working tree: 10 tasks, 0 cached, exit
0, 1,381 passed and 2 skipped in `5 m 9.4 s` of Turborepo time — the policy
layer's 579 cases over its five groups and the boundary layer's 802 cases in
274.8 s over 37 files. Its transcript is
[performance/harn-49-final-validation.txt](../performance/harn-49-final-validation.txt).
What changed after that validated revision is documentation and evidence: that
record, this section and `notes/test-layers.md`. No behaviour changed, and the
checks that read those files — `format:check`, and the configuration group
through its declared `docs/**` input — re-hash them instead of reusing the
earlier result.

Linux is a separate check, not a comparison. `bash performance/validate-linux.sh`
ran `npm run validate:fresh` on a WSL2 **ext4** filesystem (Linux
`6.18.33.2-microsoft-standard-WSL2`, Node `v24.14.1`, npm `11.11.0`, Git
`2.43.0`, revision `212aee1` with this record's working changes) and passed: 10
tasks, 0 cached, `1 m 44.2 s` of Turborepo time and 104.5 s of command wall, 37
boundary files, 794 passed and 10 platform skips, no new fixture directory and
no remaining Node or Git process. Its log is
[harn-49-linux-validation.txt](../performance/harn-49-linux-validation.txt).

An earlier attempt read the same checkout through the mounted Windows drive
(`/mnt/e`) and failed on one pre-existing case: the first ESLint fixture run in
`tests/boundaries.test.ts` took longer than its five-second default there — 346
ms on ext4, 4.7 s on that mount in the first delivery's own Linux run, over five
seconds now. A mounted drive is not what CI uses; that log is kept as
[harn-49-linux-mounted-attempt.txt](../performance/harn-49-linux-mounted-attempt.txt)
so the difference is on the record rather than smoothed over. Hosted
`ubuntu-latest` CI remains the merge gate, and no Linux number here is compared
with a Windows one.

The comparable pre-change numbers are HARN-48's: 207–210 s test phase, 219–222 s
wall. Those samples were taken at different times on a busy desktop host and are
not a controlled comparison; the honest reading is that the boundary layer still
dominates — it is what is left in the cached run — and that the reusable part
(policy, lint, type check and build) costs a cache lookup when nothing changed.
`notes/test-layers.md` records the runs and the count change.

## The build

`npm run build` is `node scripts/build.mjs`, which removes `dist/`, runs the
compiler over the current sources, and only then reports a build:

```
$ node node_modules/typescript/bin/tsc --project tsconfig.build.json   # incremental: false
$ ls dist/cli.js                                                       # present
```

The emitting program keeps **no** incremental state, and that is the point.
TypeScript's incremental mode trusts its own record of the last successful
compile: with `.tsbuildinfo` present it reports a project whose output was partly
or wholly removed as up to date and emits nothing, exit 0. Checked with the
installed 6.0.3 in both the `tsc --project` and `tsc --build` shapes:

```
$ rm dist/cli/options.js            # or: rm -rf dist
$ node node_modules/typescript/bin/tsc --project tsconfig.build.json
$ echo $?                           # 0 — and options.js is still missing
```

Generated output being absent is ordinary here: a fresh checkout, `git clean`, an
operator removing generated files, a task cache that was cleared, or a cache
whose entry was never restored. A state that describes a tree it no longer
matches turns any of those into a build that reports success with an incomplete
`dist/`, so this repository does not keep one for the emitting program. What it
costs is a full emit — about 1.5 s for this project — on a task-cache miss, which
is exactly when some input changed anyway. The check-only program keeps its
state, because it emits nothing and so has no output tree to disagree with; that
is the program whose second run saves seconds (2.8 s → 1.1 s).

`scripts/build.mjs` then verifies the one artefact `npm start` executes and fails
with an actionable message if the compiler reported success without it. It takes
an optional project directory (`node scripts/build.mjs <directory>`) so
`tests/build-guard.test.ts` can run the same guard against throwaway projects
with this checkout's own compiler: a module removed from a complete `dist/` comes
back, a module whose source is gone does not survive, a behaviour change and its
revision come back in turn, and a project that emits nothing fails.

## Lint

`eslint . --cache --cache-location .turbo/eslint/.eslintcache
--cache-strategy content` is enabled, and its soundness rests on what this
configuration lints: `eslint.config.js` uses `typescript-eslint`'s recommended
(not type-checked) rules and per-file rules only, so a file's result depends on
its own content and the resolved configuration, which is what ESLint's cache
keys on — the entry also includes the ESLint and Node versions. Adding a
type-aware or cross-file rule would break that assumption, so
`tests/validation-cache.test.ts` fails if the configuration starts using
`projectService`, a `project` setting or the type-checked presets. Whoever adds
one has to decide what the cache should do about it — most likely by dropping
`--cache` — rather than inheriting a stale answer.

A *semantic* configuration change invalidates every entry (verified); a comment
in the configuration does not, because the hash covers the resolved
configuration rather than the file's bytes.

## Troubleshooting

- **See what would happen.** `npm run validate -- --dry` prints every task with
  its hash, its inputs, and whether it would hit. `--dry=json` gives the same as
  JSON, including the files that were hashed.
- **A task misses although nothing changed.** Compare its hash between two
  `--dry=json` runs; the differing input is the answer. The usual causes are a
  different Node or npm on PATH (both are declared inputs), a changed declared
  environment value (`TZ` and the temp-directory values are declared inputs), or
  an edit recorded by `npm ci` in the lockfile.
- **The gate refuses to start with a message about `node --version`.** The
  wrapper could not observe the runtime that would execute the tasks. Put `node`
  and `npm` on PATH, or run the gate through `npm run validate` from the same
  installation; without them nothing can be reused safely, and no result is
  produced instead.
- **A reused result looks wrong.** `npm run cache:clear` and run again; if the
  miss then fails, the problem is the revision, not the cache. Nothing in the
  cache is evidence: only `npm run validate:fresh` executes everything, and only
  a fresh run on the revision being verified is a statement about that revision.
- **A result depends on something not declared.** Declare it in the task's `env`
  (or in `globalEnv`) if it is an environment value, or add it to `inputs` if it
  is a file. If it cannot be bounded that way — a real process, a host tool, a
  clock — move the case to the boundary layer and set `"cache": false` for the
  task it needs: an uncached task that runs is always correct, a cached task with
  incomplete inputs is not.
- **`npm run build` says the artefact is missing.** It emptied `dist/` and the
  compiler reported success without producing `dist/cli.js`. Check the project's
  `noEmit`, `outDir` and `include` settings; nothing was reported as built.
- **An untrusted cache, or disk space.** `npm run cache:clear`. Nothing outside
  `.turbo/` is touched, and the next validation simply executes more.

## Limits

- Caching cannot make the boundary layer faster; it is the majority of the gate
  and it runs every time by design. A case that starts a real process stays
  there, so it is never replayed.
- The build is not incremental for its emit, by design (see
  [The build](#the-build)); a cache miss costs a full compile of `src/`.
- The first validation of a fresh checkout, and every CI run, executes
  everything: CI transports no task results.
- Turborepo's hash has no operating system or architecture in it. Separate cache
  directories are what keeps two systems apart; a single cache directory shared
  between them (an explicit `--cache-dir`) would allow a cross-platform replay.
- Damaged *metadata* beside an intact output tree is not always detected, because
  Turborepo can satisfy a hit from the outputs already on disk. Damaged artifacts
  are: they fall back to execution (verified). `cache:clear` is the repair for
  any suspicion.
- Cache hits describe the revision they were produced from. They are not
  evidence that a *different* revision passes, which is why the delivered
  revision is validated with `npm run validate:fresh`.
