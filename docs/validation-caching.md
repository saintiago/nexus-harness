# Validation caching

Validation must remain correct whether the cache is empty, populated or unavailable. Reuse a
successful result only when every input that could affect it is unchanged. Caching reduces repeated
work; it does not replace checks or make a failed or interrupted check successful.

## Tooling

Use Turborepo for task caching, ESLint's native content cache for linting and TypeScript's native
incremental state for type checking. Keep repository glue limited to invocation, runtime identity
and local cache cleanup. Do not build custom cache keys, storage, invalidation or result replay.

Keep caches local to each checkout and separate by operating system and architecture. Store them
under the ignored `.turbo/` directory. Validation needs no remote cache, credentials or network
service. Cache output must not become an input to its own task.

## Eligibility

Formatting, linting, type checking, builds and deterministic policy tests may reuse successful
results. Every cached task must declare its source files, tests, imported helpers, files read as
data, configuration, dependencies and relevant environment values. The executing Node.js and npm
versions are inputs too; if their identity cannot be established, stop validation.

An edit to any relevant input must invalidate the result, including an uncommitted edit. A commit
with unchanged content need not invalidate it. When a check inspects other tests or configurations,
those inspected files are inputs to that check as well.

Tests that start real processes or observe live machine state execute on every validation. They
belong to the boundary layer, regardless of which feature they test. Live provider exercises,
agent turns, external writes, approvals and completion evidence are never cacheable validation
results. Do not add credentials to cache inputs, artifacts or logs.

When reorganizing tests, update their task membership and input declarations together. Each test
must still execute in exactly one layer, and every required layer must remain in the validation
gate. Cache eligibility follows a test's behavior, not its name.

## Execution guarantees

- A missing or unusable entry causes execution, never an assumed pass.
- A failed or interrupted task cannot supply a reusable success.
- Generated build output must be complete and correspond to current inputs, whether restored or
  rebuilt. Deleting all or part of that output must not leave a successful but incomplete build.
- Cache handling must preserve task failures and cancellation, and must not silently filter the
  environment of checks that execute against the host.
- Clearly distinguish reused results from newly executed checks. Do not present replayed logs as
  fresh evidence.
- Cache cleanup affects only the selected checkout and does not change user or global settings.

The pyramid is three validation tasks, split by what the suites do. `test:unit` is cache-eligible:
the deterministic unit project declares the sources it imports, the test tree it reads (the layer
contract inspects it) and the two documented example configurations it loads, so an edit to any of
them invalidates its result and nothing else does. `test:boundary` and `test:workflow` execute on
every validation without result reuse: the first starts real processes, Git and local services,
and the second assembles the harness behind controlled agent and service responses — neither is a
reusable observation of this host. All three are part of `npm run validate`, and a layer that
discovers no suite fails instead of passing. The archived suites are excluded from all validation
tasks.

## Commands

| Command | Behavior |
| --- | --- |
| `npm run validate` | Run all required checks, reusing eligible unchanged results. |
| `npm run validate:fresh` | Clear local caches and execute every validation task. |
| `npm run cache:clear` | Clear this checkout's local validation caches. |
| `npm run validate -- --dry` | Show task selection and cache decisions without executing checks. |
| `npm test` | Execute active suites directly, without task-result reuse. |
| `npm run test:unit` | Execute the deterministic unit project alone. |
| `npm run test:boundary` | Execute the boundary project alone, against this host. |
| `npm run test:workflow` | Execute the workflow project alone. |

A retained workspace can reuse its own unchanged results. A new checkout starts cold. Reinstalling
dependencies with an unchanged lockfile need not discard the cache; changing dependencies must
invalidate affected results. Use fresh validation when the required evidence is a new execution.
