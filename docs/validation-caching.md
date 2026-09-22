# Validation caches: what is reused, and what always runs

HARN-49. `npm run validate` is the gate CI runs and the command every change is
checked with. Most of it is deterministic work over files that usually did not
change between two validations of the same revision; the rest is real processes
whose whole point is to observe a machine. This document says which is which,
what each cache-eligible task declares as its inputs, where the caches live, and
what was actually measured.

Turborepo does the caching. This repository contributes declarations
(`turbo.json`), the native caches the tools already have (ESLint's content
cache, TypeScript's incremental metadata) and three small scripts under
`scripts/`. No part of this repository hashes inputs, stores results, invalidates
entries or replays work by itself; that was the point of choosing a maintained
task cache over a hand-rolled one (see [Why Turborepo](#why-turborepo)).

## The gate as tasks

| Task                    | Cache | Declared inputs                                                                 | Outputs                        |
| ----------------------- | ----- | ------------------------------------------------------------------------------- | ------------------------------ |
| `format:check`          | yes   | `$TURBO_DEFAULT$` — every file git does not ignore                               | none                           |
| `lint`                  | yes   | `$TURBO_DEFAULT$` minus Markdown, `docs/`, `notes/`, `performance/`              | none                           |
| `typecheck`             | yes   | `src/**`, `tests/**`, `tsconfig*.json`, `vitest*.config.ts`                      | none                           |
| `build`                 | yes   | `src/**`, `tsconfig*.json`                                                       | `dist/**`                      |
| `test:policy:display`   | yes   | `src/**`, `tests/activity.test.ts`, `tests/report.test.ts` and what they read    | none                           |
| `test:policy:config`    | yes   | `src/**`, the five configuration/contract test files and what they read          | none                           |
| `test:policy:loop`      | yes   | `src/**`, the five run-loop/completion policy files and what they read           | none                           |
| `test:policy:intake`    | yes   | `src/**`, the four queue/Jira/baseline-finding files and what they read          | none                           |
| `test:policy:history`   | yes   | `src/**`, the four history/review files and what they read                       | none                           |
| `test:boundary`         | **no**| `src/**`, `tests/**`, `tsconfig*.json`, `vitest*.config.ts`                      | nothing is ever stored         |

Every task's row is the `turbo.json` entry of the same name; the test groups
also declare `tests/support.ts`, `tests/reviews-shared.ts` or `tests/fixtures/**`
where their files reach those helpers, `vitest.config.ts` (the layer's file list,
project settings and worker caps), and `eslint.config.js` for the group that
reads it. `package.json`, `package-lock.json`, `turbo.json`, `.gitattributes`
and `.nvmrc` are in every task's hash through Turborepo's global inputs.

Each policy group names its own files instead of falling back to "everything in
the checkout". A change to one test file therefore invalidates that group, the
checks that read every source file (`lint`, `typecheck`, `format:check`) and the
build if it is a source change — not every group. A change that *every* cached
task genuinely reads (a source file, the lockfile, a declared environment value)
invalidates everything it should.

### Why the boundary layer is never cached

`test:boundary` runs the thirty-three process-heavy files: real Git repositories,
real command trees that must be stopped, the fixture lifecycle proof that starts
failing, timing-out and cancelling cases in a nested run, the built CLI as a
process, and the stand-in runtime. Their value is the observation of a live
machine — a deadline that expired, a child tree that ended, a directory that was
released — and HARN-48's audit is the record of how contention changes what they
observe. A replayed result would describe a machine that no longer exists, so
the task declares `"cache": false` and runs on every validation, before nothing
and after all five policy groups (`dependsOn`). `tests/validation-cache.test.ts`
fails if that ever stops being true.

Nothing else is eligible either, and nothing outside this repository is:

| Never cached                                                                    | Why                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `npm run test:live` (the opt-in provider exercise)                               | It drives a real coding agent and is not part of the gate |
| Agent turns, Jira or GitHub writes, approvals, completion evidence                | Foreign state that changes under the run                |
| Supervisor and recovery lifecycle evidence, active-process checks, Jira/GitHub reads | HARN-51: always read fresh, never replayed           |
| Target-repository commands                                                        | This is repository tooling for *this* repository         |

The cache holds task results only. No case shares a mutable Git repository, a
running process or a test workspace with another: every fixture still creates
its own throwaway directory per test (`tests/fixtures/lifecycle.ts`), and the
cache never stores or restores one.

## Inputs and invalidation

What invalidates an entry is exactly what the task declares, plus Turborepo's
global inputs:

- **Files.** Each cached task declares the files it reads. Turborepo hashes their
  contents; a new file that a declared glob covers counts as a change, and a file
  no task declares does not. Markdown and recorded evidence are deliberately out
  of `lint`; `$TURBO_DEFAULT$` on `format:check` means the default file set,
  which is every file git does not ignore — a superset of what Prettier reads,
  which is the safe direction.
- **The lockfile and manifests.** `package.json`, `package-lock.json` and
  `turbo.json` are in every task's hash, so installing different tools, changing
  a script or re-declaring the pipeline invalidates everything.
- **The runtime and the platform.** `.nvmrc` is a global dependency, so the
  declared Node version is an input. Turborepo's own hash does *not* include the
  operating system or the architecture (verified: the global inputs are the root
  key, the global files above, dependency hashes, declared environment values and
  `engines`), so the cache *directory* is per platform and architecture instead —
  see [Where the caches live](#where-the-caches-live).
- **Git state.** Turborepo hashes file contents, not the commit. A commit of
  identical content — which is the ordinary case when the harness records a
  coding turn — does not invalidate anything; an uncommitted edit to a declared
  input does. Verified with a probe task: amending a commit without changing the
  tree kept the same task hash.
- **Environment.** Every cached test task declares `TZ`, `LANG`, `LC_ALL`,
  `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP` and `VITEST_*`; every task declares `CI`,
  `NODE_ENV` and `NODE_OPTIONS` globally. The rule for
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

| Path                             | Written by | What it is                                            |
| -------------------------------- | ---------- | ----------------------------------------------------- |
| `.turbo/cache/<os>-<arch>/`      | Turborepo  | successful task results, their logs and `dist/`       |
| `.turbo/eslint/.eslintcache`     | ESLint     | per-file lint results, keyed by content and configuration |
| `.turbo/tsc/typecheck.tsbuildinfo` | TypeScript | incremental state for the check-only program         |
| `.turbo/tsc/build.tsbuildinfo`   | TypeScript | incremental state for the emitting program            |

`scripts/turbo.mjs` is the only way the gate invokes Turborepo. It adds
`--cache-dir=.turbo/cache/<platform>-<arch>`, which both separates the platforms
and turns off Turborepo's automatic sharing between Git worktrees, and it turns
telemetry and the update notifier off for the invocation. It contains no caching
logic of its own. An explicit `--cache-dir` argument still wins, so
`npm run validate -- --cache-dir=.turbo/cache/try` works.

Nothing here is shared: there is no remote cache (`"remoteCache": { "enabled":
false }`), no login, no token, no service, and no CI cache of task results. The
`.turbo/` directory is ignored by git, by Prettier and by ESLint, so a cache can
neither dirty the checkout nor change the checks that decide whether it may be
reused.

## Commands

| Command                  | What it does                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `npm run validate`       | The gate: every task above, reusing a successful result only where the inputs are unchanged.      |
| `npm run validate:fresh` | Clears the local caches, then runs the gate: every task executes, nothing is replayed.            |
| `npm run cache:clear`    | Removes `.turbo/` for this checkout. Never touches global configuration or another checkout.      |
| `npm test`               | Both layers directly, without the task cache. For a quick look, not the gate.                      |
| `npm run test:policy`    | The fast layer alone, directly.                                                                    |
| `npm run test:boundary`  | The process-heavy layer alone, directly.                                                           |
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
- **Missing build output is regenerated.** `npm run build` routes through
  `scripts/build.mjs`, which discards the incremental state when `dist/cli.js`
  is absent and fails the build if the compiler reports success without
  producing it. See [Missing build output](#missing-build-output).
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
  hit, rebuilt from scratch by the guard when it is missing, and left alone when
  the compiler's incremental state already describes it. Deleting `dist/` never
  turns into a build that reports success without it.
- **Several checkouts.** Each checkout has its own cache. Nothing is shared
  between them, so an operator cannot validate one revision against another's
  results.

## Why Turborepo

The requirement was content-based caching of successful, deterministic *test*
results, with per-task inputs, in a single-package repository, without building
cache machinery here.

- **Native caches alone are not enough.** ESLint caches per file and TypeScript
  incrementally, and both are enabled — but Vitest has no result cache, so
  "the policy layer already passed for these files" needs a task-level cache.
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
ESLint `10.10.0`, Vitest `5.0.0`, Git `2.53.0.windows.2`. Linux is a separate
check: `bash performance/validate-linux.sh` ran the same gate with the caches
cleared on WSL2 (Linux `6.18.33.2-microsoft-standard-WSL2`, Node `v24.14.1`, npm
`11.11.0`, Git `2.43.0`, this checkout read through `/mnt/e`) and passed — 10
tasks, 34 boundary files, 1,363 passed and 10 platform skips in 157.65 s, with no
new fixture directory and no remaining Node or Git process. Its log is
[performance/harn-49-linux-validation.txt](../performance/harn-49-linux-validation.txt). No timing
here is compared with a Linux number, and hosted `ubuntu-latest` CI remains the merge gate.

| What                                                       | How                                                                     | Result                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| An unchanged rerun hits every eligible task                 | `performance/measure-windows.ps1`: the gate with the cache cleared, then unchanged | Second run: `Cached: 9 cached, 10 total`, every eligible task replayed; `test:boundary` executed fresh |
| A task really is not executed on a hit                      | `tests/validation-cache-turbo.test.ts` (fixture records its own execution) | Hit replays the logs; the fixture's marker file does not grow          |
| Declared inputs invalidate, undeclared files do not         | Same fixture: edit `src/input.txt`, add `notes.md`, add a file under `src/**` | Miss after both declared changes; hit after the unrelated file      |
| A declared output comes back when it is missing             | Remove `out/**`, rerun                                                  | Hit, output restored, task not executed                                 |
| A failed task is never stored as a success                  | Run a failing fixture task twice                                        | Both runs exit nonzero, both execute                                    |
| Interrupted work is never replayed                          | Stop a fixture task inside its work, rerun the same inputs               | The rerun executes and produces the output                              |
| A damaged cache entry cannot become a success                | Overwrite the stored artefact, remove the output, rerun                  | Treated as a miss and executed; exit 0 only with the output present     |
| A relevant source edit invalidates the work it affects      | Edit `src/cli.ts`, run the gate, revert it                              | After the edit: **0 cached**, all ten tasks executed. After the revert: the earlier results came back (8 cached — the formatting task had no stored success for that exact content and ran again) and the boundary layer ran, as always |
| A test-file edit invalidates one group, not all             | `npm run validate -- --dry` with one test file edited                   | That group's hash changed; the other four kept theirs                   |
| A declared environment value invalidates the test tasks     | `npm run validate -- --dry` with `TZ` set                               | The five test tasks changed their hash; the other tasks did not         |
| The native lint cache is invalidated by a configuration change | Add a rule to `eslint.config.js`, run `npm run lint`                 | Every file re-linted (159 problems reported); a comment in the same file did not invalidate anything |
| The native lint cache survives unchanged files               | `npm run lint` twice                                                    | 3.2 s cold, 1.2 s warm                                                   |
| Incremental type checking and emission work                  | `npm run typecheck` / `npm run build` twice                             | 2.8 s → 1.1 s and 1.77 s → 0.87 s                                        |
| Missing build output is regenerated                          | Remove `dist/`, keep `.tsbuildinfo`, build                              | The guard discarded the state, compiled from scratch, `dist/cli.js` present |
| The compiler alone would not have emitted                    | Same removal, `tsc --project tsconfig.build.json` directly               | Exit 0 with no `dist/` — the reason the guard exists                     |
| A commit of unchanged content does not invalidate            | Compare `--dry` hashes before and after committing the same tree         | Identical hashes and hit predictions                                     |
| The repository's declarations stay complete                  | `tests/validation-cache.test.ts`                                         | Fails if a group stops declaring a file it reads, if the boundary layer becomes cacheable, or if the caches stop being ignored |

The recorded measurement is in [performance/measure-windows.ps1](../performance/measure-windows.ps1)
and its raw output:

| Run (same revision, same host) | Turborepo summary             | Command wall | Layer detail                                                    |
| ------------------------------ | ----------------------------- | ------------ | --------------------------------------------------------------- |
| `npm run validate:fresh`       | 10 successful, 0 cached, 3 m 18.9 s | 199.77 s | policy 8.9 s over five groups; boundary 176.05 s over 34 files   |
| `npm run validate`             | 10 successful, **9 cached**, 2 m 51.8 s | 172.13 s | the five groups, lint, type check, build and formatting replayed; the boundary layer executed (171.28 s) |

Files: [fresh metadata](../performance/harn-49-validation-fresh.txt) and
[transcript](../performance/harn-49-validation-fresh-detail.txt),
[cached metadata](../performance/harn-49-validation-cached.txt) and
[transcript](../performance/harn-49-validation-cached-detail.txt), and the
[cleanup inventory](../performance/harn-49-validation-cached-cleanup.txt) — both runs started and
ended with no new fixture directory and no new Node/Git/cmd/taskkill process identity. The repair
cycle above is recorded the same way in
[performance/harn-49-repair-cycle.txt](../performance/harn-49-repair-cycle.txt).

The comparable pre-change numbers are HARN-48's: 207–210 s test phase, 219–222 s
wall. Those samples were taken at different times on a busy desktop host and are
not a controlled comparison; the honest reading is that the boundary layer still
dominates — it is what is left in the cached run — and that the reusable part
(policy, lint, type check and build) costs a cache lookup when nothing changed.
`notes/test-layers.md` records the runs and the count change.

## Missing build output

TypeScript's incremental state is a record of what the last successful compile
emitted, and the compiler trusts it. With `.turbo/tsc/build.tsbuildinfo` present,
deleting `dist/` and running the compiler again produces:

```
$ node node_modules/typescript/bin/tsc --project tsconfig.build.json
$ echo $?
0                      # dist/cli.js is still missing
```

Both `tsc --project` and `tsc --build` behave this way (checked with the
installed 6.0.3), and generated output being absent is ordinary here: a fresh
checkout, `git clean`, an operator removing generated files, or a task cache
that was cleared. `scripts/build.mjs` therefore removes the incremental state
when `dist/cli.js` is missing and then runs the compiler, so the emit really
happens; if the compiler reports success and the artifact is still missing, the
build fails with the command to repair the state (`npm run cache:clear`).

The guard covers the entry point, which is what `npm start` and every fixture
spawn. A partially removed `dist/` whose entry point still exists is not
detected by it; Turborepo restores the whole declared output tree on a hit, and
`npm run validate:fresh` clears the compiler state so the next build emits
everything. Nothing hand-edits `dist/`; it is generated output.

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

A *semantic* configuration change invalidates every entry (verified above); a
comment in the configuration does not, because the hash covers the resolved
configuration rather than the file's bytes.

## Troubleshooting

- **See what would happen.** `npm run validate -- --dry` prints every task with
  its hash, its inputs, and whether it would hit. `--dry=json` gives the same as
  JSON, including the files that were hashed.
- **A task misses although nothing changed.** Compare its hash between two
  `--dry=json` runs; the differing input is the answer. The usual causes are a
  different Node version, a changed declared environment value (`TZ` and the
  temp-directory values are declared inputs), or an edit recorded by
  `npm ci` in the lockfile.
- **A reused result looks wrong.** `npm run cache:clear` and run again; if the
  miss then fails, the problem is the revision, not the cache. Nothing in the
  cache is evidence: only `npm run validate:fresh` executes everything, and only
  a fresh run on the revision being verified is a statement about that revision.
- **A result depends on something not declared.** Declare it in the task's `env`
  (or in `globalEnv`) if it is an environment value, or add it to `inputs` if it
  is a file. If it cannot be bounded that way, set `"cache": false` for that
  task: an uncached task that runs is always correct, a cached task with
  incomplete inputs is not.
- **Disc space, or a cache an operator does not trust.** `npm run cache:clear`.
  Nothing outside `.turbo/` is touched, and the next validation simply executes
  more.

## Limits

- Caching cannot make the boundary layer faster; it is the majority of the gate
  and it runs every time by design.
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
