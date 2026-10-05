# HARN-99 activation and KAN-76 resumption

Operational preparation for HARN-99 (task 3 of HARN-96): activate the checked merged Nexus
installation at a safe execution boundary and resume KAN-76's retained requirements checkpoint.

The initiating task owns the final activation and the scoped KAN-76 resumption. These scripts are
the reviewable preparation; the run evidence lives under
`/home/aiur/.local/share/nexus/harn99-activation/` and the reconciled rejection records under
`/home/aiur/.local/share/nexus/workspaces/KAN/KAN-76/requirements/report-feedback/`. None of these
scripts edits product documentation, and none of them is run by validation.

## Scripts

- `prepare-kan76-resumption.mjs` — verifies the retained checkpoint and the captured rejection
  evidence, attributes each rejection to the violated rule its retained execution event actually
  reported (the merged validator's replay of the same bytes is kept as additional correction
  guidance, never substituted for the historical rule), reproduces both captured rejections through
  the merged `StageAuthor` and rehearses the resumption on disposable copies (feedback supplied,
  replacement validated and saved, correction recorded, evaluator revision-bound). With `--apply`
  it writes the immutable rejection records under KAN-76's requirements area with the merged
  writer; a record an earlier reconciliation wrote with a replay rule is reconciled in place, with
  its replaced bytes preserved under `<evidence>/superseded/`. It never starts KAN-76 and never
  invokes a provider.
- `check-activation-readiness.mjs` — records the merged revision's required GitHub checks, the
  resolved launch target, the active runtime users, installed-profile parity, the configuration's
  workflow paths, the derived scoped KAN-76 project configuration and real provider turns with the
  stage-author response schema.
- `activate-and-resume.mjs <merged-revision>` — run from a separate visible WSL terminal with
  `node operations/harn99/activate-and-resume.mjs <merged-revision>`. It refuses while another
  Nexus runtime user is active, backs up host settings and KAN-76's retained recovery execution
  record, fast-forwards and builds the installation, verifies the resolved launch target and
  profile parity, rehearses the recovery-allowance carry on the rebuilt installation, records the
  activation evidence and then runs the normal queue scoped to KAN-76. `Application.execute`
  records a fresh allowance (`invocations: 0`) before the first worker starts. The operational
  entry `run-retained-queue.mjs` wraps Application's awaited worker launcher: it restores and
  verifies the retained count inside the queue parent before launching the first worker. If the
  startup record is unexpected, or restoration, verification or evidence writing fails, it throws
  out of execution and the command exits 1 without invoking a worker or recovery. Subsequent worker
  restarts use the consumed count normally. Startup evidence (original/reset/carried records with
  hashes) lives in `kan76-startup-carry.json`; final evidence lives in `kan76-resumption.json`.
- `activate-and-resume.mjs --rehearse [--dist <build>]` — touches no real KAN-76 state: it drives the
  real operator command, Application, recovery lifecycle and worker/process launcher in separate
  disposable processes. The worker launch fails immediately with ENOENT, while supervisor
  observation is delayed 100ms at the first-launch boundary. The control run consumes an extra
  invocation; the carried run retains 3/3 with zero recovery invocations. An unexpected startup
  record proves refusal stops before either worker launch or recovery. The fixture
  `rehearse-retained-queue.mjs` substitutes only the recovery runtime and faulting worker target.
  Evidence: `recovery-carry-rehearsal.json`.

## Remaining for the initiating task

1. After HARN-99's reviewed delivery merged and its required checks passed, confirm the solved
   revision and that every active Nexus execution finished or reached a normal retained stop.
2. In a separate visible WSL terminal, run
   `node operations/harn99/activate-and-resume.mjs <merge-revision>`; KAN-76's retained
   requirements checkpoint then resumes with the original rejection and correction guidance, and
   its actual author/evaluator outcomes are retained. The run carries KAN-76's consumed recovery
   allowance (3 of 3) through queue startup, so the resumption grants no additional automatic
   recovery invocation.
3. Record any operational limitation observed during activation or resumption.

## Known limitations

- The provider probes are real binds of profile, model and response schema, but their prompt is
  shorter than a full workflow invocation; a compliant probe does not guarantee every future turn.
- Resumption itself is not claimed here: the reconciled feedback only reaches the author when the
  queue resumes under the activated installation.
- The carry requires the inspected Application ordering: `begin()` publishes the startup reset,
  then awaits its worker launcher before recovery. The rehearsal verifies this ordering against the
  rebuilt installation before actual resumption. A changed startup record prevents continuation.
  The final count is supplementary evidence; it cannot by itself prove no extra invocation ran.
