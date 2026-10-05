#!/usr/bin/env node
/**
 * HARN-99: reconcile KAN-76's supplied legacy rejection evidence into the merged report-feedback
 * contract and rehearse the retained requirements checkpoint's resumption.
 *
 * The script never starts KAN-76, never invokes an agent provider and never edits product
 * documentation. It:
 *   1. verifies the retained checkpoint, the captured rejection evidence and the merged helpers;
 *   2. attributes each captured rejection to the violated rule the retained execution event
 *      actually reported, reproduces both through the real StageAuthor in disposable copies and
 *      keeps the merged validator's replay diagnostics as additional correction guidance;
 *   3. rehearses the resumption in a disposable copy: the author receives the reconciled feedback,
 *      a conforming response is validated and saved, the correction retires the rejections and the
 *      evaluator assesses the new revision;
 *   4. with --apply, writes the immutable rejection records under KAN-76's requirements area using
 *      the merged writer, reconciling an already-written record whose rule the earlier round took
 *      from the replay diagnostic (its replaced bytes are preserved as evidence), then verifies
 *      artifacts, state and allowances are unchanged.
 *
 * Evidence is written under --evidence-dir, outside product documentation.
 *
 * Usage:
 *   node operations/harn99/prepare-kan76-resumption.mjs [--apply]
 *     [--nexus-dist <checkout>/dist] [--workspace-root <KAN-76 root>]
 *     [--selection-file <executions/KAN/selection.json>] [--execution-dir <executions/KAN>]
 *     [--evidence-dir <dir>] [--expected-merge <revision>]
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const defaults = {
  nexusDist: '/home/aiur/projects/nexus/dist',
  workspaceRoot: '/home/aiur/.local/share/nexus/workspaces/KAN/KAN-76',
  selectionFile: '/home/aiur/.local/share/nexus/executions/KAN/selection.json',
  executionDir: '/home/aiur/.local/share/nexus/executions/KAN',
  evidenceDir: '/home/aiur/.local/share/nexus/harn99-activation',
  expectedMerge: '84f273c54bf1013203e454cd28e5e4fb4585792b',
};

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
};
const apply = argv.includes('--apply');
const settings = {
  nexusDist: path.resolve(option('--nexus-dist', defaults.nexusDist)),
  workspaceRoot: path.resolve(option('--workspace-root', defaults.workspaceRoot)),
  selectionFile: path.resolve(option('--selection-file', defaults.selectionFile)),
  executionDir: path.resolve(option('--execution-dir', defaults.executionDir)),
  evidenceDir: path.resolve(option('--evidence-dir', defaults.evidenceDir)),
  expectedMerge: option('--expected-merge', defaults.expectedMerge),
};

const stage = 'requirements';
const round = 3;
const areaRoot = path.join(settings.workspaceRoot, stage);
const worktree = path.join(settings.workspaceRoot, 'worktree');

/** The two captured author turns whose rejection evidence the contract never retained. */
const capturedTurns = [
  {
    round: 2,
    invocationId: 'a0c2f0ec-e080-48c2-9948-1c6a80770d73',
    startedAtUnixMs: 1791185449647,
    profile: 'nexus-sol',
    capturedAtHead: 'f109de4140c18957cb155b939dd0f6d3b8f08bf6',
    recoveryCapture: path.join(
      settings.executionDir,
      'recovery/KAN-76-requirements-round-2-ownership/round-2-rejected-response.json',
    ),
  },
  {
    round: 3,
    invocationId: 'a2a8755f-fd2b-443d-83a4-f596e5ed28b0',
    startedAtUnixMs: 1791185931017,
    profile: 'nexus-sol',
    capturedAtHead: 'd2fe63172d8dbdba28114194d3f658720d4bde19',
    recoveryCapture: path.join(
      settings.executionDir,
      'recovery/KAN-76-requirements-round-3-recurrence/rejected-response.json',
    ),
  },
];

const evidence = {};
const record = (name, value) => {
  evidence[name] = value;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};
const git = (...args) =>
  execFileSync('git', args, { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const imported = async (relative) =>
  import(pathToFileURL(path.join(settings.nexusDist, relative)).href);

/** The Nexus queue processes that would race this reconciliation or the later resumption. */
async function activeQueueProcesses() {
  const matches = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let command;
    try {
      command = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0').join(' ');
    } catch {
      continue;
    }
    if (
      (command.includes('cli.js queue run') &&
        (command.includes('magic-collection-keeper') ||
          command.includes('kan76-scoped.project.json'))) ||
      command.includes('/harn99/run-retained-queue.mjs')
    ) {
      matches.push({ pid: Number(entry), command: command.trim() });
    }
  }
  return matches;
}

/** The retained agent activity file of one captured invocation. */
async function activityFileFor(invocationId) {
  for (const entry of await readdir(path.join(settings.executionDir, 'logs'))) {
    const directory = path.join(settings.executionDir, 'logs', entry, 'agents');
    if (!(await exists(directory))) {
      continue;
    }
    for (const file of await readdir(directory)) {
      if (file.startsWith('requirements-author-') && file.endsWith(`${invocationId}.jsonl`)) {
        return path.join(directory, file);
      }
    }
  }
  throw new Error(
    `No retained requirements-author activity file names invocation ${invocationId}.`,
  );
}

/** The exact returned bytes of one captured invocation: its last recorded agent message. */
async function capturedOutput(turn) {
  const file = await activityFileFor(turn.invocationId);
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  const last = JSON.parse(lines.at(-1));
  if (last?.activity?.type !== 'message' || typeof last.activity.text !== 'string') {
    throw new Error(`The last activity of ${file} is not a final agent message.`);
  }
  const output = last.activity.text;
  const recovered = await readFile(turn.recoveryCapture, 'utf8');
  const sameContent = JSON.stringify(JSON.parse(output)) === JSON.stringify(JSON.parse(recovered));
  if (!sameContent) {
    throw new Error(
      `The retained activity and the recovery capture of round ${String(turn.round)} disagree.`,
    );
  }
  return {
    file,
    fileSha256: sha256(await readFile(file)),
    outputSha256: sha256(output),
    recoveryCapture: turn.recoveryCapture,
    recoveryCaptureSha256: sha256(recovered),
    output,
    startedAt: last.timestamp,
  };
}

/** The retained execution event log one invocation's activity file belongs to. */
function executionEventsFile(activityFile) {
  return path.join(path.dirname(path.dirname(activityFile)), 'events.jsonl');
}

/** The recorded invocation attribution of one captured turn, from the execution event log. */
async function capturedAttribution(turn, activityFile) {
  const events = (await readFile(executionEventsFile(activityFile), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const started = events.find(
    (entry) =>
      entry.event?.type === 'agent-started' && entry.event.data?.invocationId === turn.invocationId,
  );
  if (started === undefined) {
    throw new Error(`No agent-started event records invocation ${turn.invocationId}.`);
  }
  const data = started.event.data;
  if (
    data.operation !== 'stage-author' ||
    data.profile !== turn.profile ||
    data.startedAtUnixMs !== turn.startedAtUnixMs ||
    data.task !== 'KAN-76'
  ) {
    throw new Error(
      `The recorded attribution of invocation ${turn.invocationId} does not match the capture.`,
    );
  }
  return {
    operation: data.operation,
    profile: data.profile,
    startedAtUnixMs: data.startedAtUnixMs,
    log: data.log.path,
    eventTimestamp: started.timestamp,
  };
}

/**
 * The violated rule the stopped invocation actually reported, from the retained execution event
 * that followed it. The merged validator's replay of the same bytes answers a different question:
 * it is recorded separately so the historical rule stays attributable to its own invocation.
 */
async function capturedHistoricalReason(turn, activityFile) {
  const file = executionEventsFile(activityFile);
  const bytes = await readFile(file);
  const events = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const finished = events.find(
    (entry) =>
      entry.event?.type === 'agent-finished' &&
      entry.event.data?.invocationId === turn.invocationId,
  );
  if (finished === undefined) {
    throw new Error(`No agent-finished event records invocation ${turn.invocationId}.`);
  }
  const recovering = events.find(
    (entry) =>
      Date.parse(entry.timestamp) > Date.parse(finished.timestamp) &&
      entry.event?.source === 'application' &&
      entry.event?.type === 'recovering' &&
      typeof entry.event.data?.reason === 'string',
  );
  if (recovering === undefined) {
    throw new Error(
      `No recovering event follows invocation ${turn.invocationId}; its historical rejection ` +
        'is absent from the retained execution log.',
    );
  }
  const raw = recovering.event.data.reason;
  const executionPrefix = 'Execution fault: Workflow execution failed: ';
  const reason = raw.startsWith(executionPrefix) ? raw.slice(executionPrefix.length) : raw;
  if (!reason.startsWith('The requirements author report is unusable: ')) {
    throw new Error(
      `The recovering event after invocation ${turn.invocationId} does not state the author ` +
        `rejection: ${raw}`,
    );
  }
  return {
    file,
    fileSha256: sha256(bytes),
    eventTimestamp: recovering.timestamp,
    raw,
    reason,
  };
}

/** One disposable copy of the retained checkpoint: the stage area and a clone of the checkout. */
async function disposableCheckpoint() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-kan76-resumption-'));
  const issueRoot = path.join(directory, 'KAN', 'KAN-76');
  await mkdir(issueRoot, { recursive: true });
  await cp(areaRoot, path.join(issueRoot, stage), { recursive: true });
  // The copy is the checkpoint as it was before this script reconciled the captured rejections, so
  // replay and rehearsal write those records themselves instead of inheriting their own output.
  const feedbackDirectory = path.join(issueRoot, stage, 'report-feedback');
  if (await exists(feedbackDirectory)) {
    for (const file of await readdir(feedbackDirectory)) {
      const record = JSON.parse(await readFile(path.join(feedbackDirectory, file), 'utf8'));
      if (
        record.kind === 'rejection' &&
        capturedTurns.some((turn) => turn.invocationId === record.invocationId)
      ) {
        await rm(path.join(feedbackDirectory, file), { force: true });
      }
    }
  }
  execFileSync(
    'git',
    ['clone', '--quiet', '--no-hardlinks', worktree, path.join(issueRoot, 'worktree')],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    `${JSON.stringify(
      {
        taskKey: 'KAN-76',
        source: { kind: 'jira', issueId: '10994' },
        task: { id: '10994', key: 'KAN-76', fields: {} },
        conversation: [],
        workspace: { root: issueRoot },
        stage,
      },
      null,
      2,
    )}\n`,
  );
  return { directory, issueRoot, selectionFile, worktree: path.join(issueRoot, 'worktree') };
}

/**
 * Keep the exact bytes one already-written record is reconciled from under the evidence directory,
 * so the superseded content stays readable and attributable. A re-run must find the same bytes.
 */
async function preserveSuperseded(file, bytes) {
  const directory = path.join(settings.evidenceDir, 'superseded');
  await mkdir(directory, { recursive: true });
  const preserved = path.join(directory, path.basename(file));
  if (await exists(preserved)) {
    const kept = await readFile(preserved);
    if (!kept.equals(bytes)) {
      throw new Error(
        `The preserved copy at ${preserved} differs from the record it supersedes; review it first.`,
      );
    }
    return preserved;
  }
  await writeFile(preserved, bytes);
  return preserved;
}

/** Replace one retained record's content the way the merged writer publishes a new one. */
async function writeJsonAtomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Keep the previous reconciliation evidence before a run replaces it. */
async function preservePreviousEvidence(evidenceFile) {
  if (!(await exists(evidenceFile))) {
    return null;
  }
  const directory = path.join(settings.evidenceDir, 'superseded');
  await mkdir(directory, { recursive: true });
  const preserved = path.join(
    directory,
    `kan76-reconciliation-${new Date().toISOString().replaceAll(/[-:.]/g, '')}.json`,
  );
  await writeFile(preserved, await readFile(evidenceFile), { flag: 'wx' });
  return preserved;
}

const scriptedRunner = (responses, contexts) => ({
  async run(request) {
    contexts.push(request.context);
    const response = responses.length > 1 ? responses.shift() : responses[0];
    return { ok: true, value: { output: JSON.stringify(response) } };
  },
});

const conformingSkip = {
  outcome: 'skip-proposed',
  summary:
    'The retained requirements documents already cover the captured KAN-76 outcome; no additional ' +
    'authored work is needed for this stage.',
  documents: [],
  sourcePaths: [],
  observation: null,
  plan: [],
  skip: {
    reason:
      'The current worktree requirements, validation-selection and delivery documents cover the ' +
      'captured outcome; this proposal makes no implementation-completion claim.',
    references: [
      'docs/requirements.md',
      'docs/testing.md',
      'docs/ci-cd.md',
      'docs/tech-stack.md',
      'README.md#checks',
      'docs/release-checklist.md',
    ],
  },
  question: null,
  upstream: null,
  findingResponses: [],
};

const conformingEvaluation = {
  assessedRevision: 3,
  verdict: 'accepted-skip',
  reason: 'The retained requirements documents satisfy the stage; the proposal is usable.',
  observation: null,
  findings: [],
  priorFindings: [],
  upstream: null,
};

async function main() {
  const { createGitAdapter } = await imported('src/adapters/git.js');
  const { run } = await imported('src/adapters/processes.js');
  const reportFeedback = await imported('src/task-engine/actions/report-feedback.js');
  const { createStageAuthor } = await imported(
    'src/task-engine/actions/preparation/stage-author/index.js',
  );
  const { createStageEvaluator } = await imported(
    'src/task-engine/actions/preparation/stage-evaluator/index.js',
  );
  const { stageReportScope } = await imported('src/task-engine/actions/preparation/artifacts.js');
  const adapter = createGitAdapter((args, directory, onOutput) =>
    run({ executable: 'git', args, directory, environment: process.env }, onOutput),
  );

  record('startedAt', new Date().toISOString());
  record('apply', apply);
  record('nexusDist', settings.nexusDist);

  // --- Preconditions -------------------------------------------------------------------------
  const active = await activeQueueProcesses();
  if (active.length > 0) {
    throw new Error(
      `A KAN queue is active (${active.map((process) => String(process.pid)).join(', ')}); ` +
        'reconcile and rehearse only while no runtime user can resume KAN-76.',
    );
  }
  const selection = await readJson(settings.selectionFile);
  const plan = await readJson(path.join(areaRoot, 'state/current-round.json'));
  const prepared = await readJson(
    path.join(settings.workspaceRoot, 'parent/prepared-repository.json'),
  );
  const head = git('rev-parse', 'HEAD').trim();
  const branch = git('branch', '--show-current').trim();
  const status = git('status', '--porcelain=v1').trim();
  if (selection.taskKey !== 'KAN-76' || selection.workspace.root !== settings.workspaceRoot) {
    throw new Error('The KAN selection does not name this KAN-76 workspace.');
  }
  if (plan.stage !== stage || plan.round !== round || plan.route !== 'new') {
    throw new Error(`The retained plan is not the ${stage} round ${String(round)} plan.`);
  }
  if (branch !== prepared.branch || status !== '') {
    throw new Error(`The KAN-76 checkout is not the clean ${prepared.branch} branch.`);
  }
  if (head !== capturedTurns[1].capturedAtHead) {
    throw new Error(
      `The KAN-76 checkout is at ${head}, not the captured ${capturedTurns[1].capturedAtHead}.`,
    );
  }
  if (
    !(await exists(path.join(settings.nexusDist, 'src/task-engine/actions/report-feedback.js')))
  ) {
    throw new Error(
      `The merged report-feedback helpers are absent from ${settings.nexusDist}; ` +
        'build or activate the checked revision first.',
    );
  }
  // The reconciliation must leave the consumed recovery allowance exactly as it found it.
  const recoveryRecordFile = path.join(settings.executionDir, 'recovery/execution.json');
  if (!(await exists(recoveryRecordFile))) {
    throw new Error(`The retained recovery execution record ${recoveryRecordFile} is absent.`);
  }
  const retainedRecoverySha256 = sha256(await readFile(recoveryRecordFile));
  const scope = stageReportScope({
    project: reportFeedback.projectOfWorkspace(settings.workspaceRoot),
    workId: 'KAN-76',
    area: areaRoot,
    stage,
    role: 'author',
  });
  record('preconditions', {
    selection: { taskKey: selection.taskKey, stage: selection.stage },
    plan,
    preparedRepository: prepared,
    branch,
    head,
    clean: status === '',
    recoveryExecution: { file: recoveryRecordFile, sha256: retainedRecoverySha256 },
    scope,
  });

  // --- Captured evidence ---------------------------------------------------------------------
  const turns = [];
  for (const turn of capturedTurns) {
    const capture = await capturedOutput(turn);
    const attribution = await capturedAttribution(turn, capture.file);
    const historical = await capturedHistoricalReason(turn, capture.file);
    turns.push({ ...turn, ...capture, attribution, historical });
  }
  record('capturedTurns', turns);
  const snapshotBefore = {
    worktreeStatus: status,
    worktreeHead: head,
    artifactsListing: (await readdir(path.join(areaRoot, 'artifacts'))).sort(),
    stateListing: (await readdir(path.join(areaRoot, 'state'))).sort(),
    parentListing: (await readdir(path.join(settings.workspaceRoot, 'parent'))).sort(),
    authorRound2Sha256: sha256(await readFile(path.join(areaRoot, 'artifacts/2/author.json'))),
    planSha256: sha256(await readFile(path.join(areaRoot, 'state/current-round.json'))),
    recoveryExecutionSha256: retainedRecoverySha256,
    existingFeedback: (await reportFeedback.readReportFeedback(areaRoot)).map((entry) => ({
      path: entry.path,
      kind: entry.record.kind,
      reason: entry.record.kind === 'rejection' ? entry.record.reason : null,
    })),
  };
  record('snapshotBefore', snapshotBefore);

  // --- Replay: the merged StageAuthor still rejects the captured responses --------------------
  const reproduction = [];
  for (const turn of turns) {
    const copy = await disposableCheckpoint();
    const replay = createStageAuthor({
      selectionFile: copy.selectionFile,
      stage,
      git: adapter,
      publish: () => undefined,
      runner: {
        async run() {
          return { ok: true, value: { output: turn.output } };
        },
      },
    });
    const rejection = await replay({ task: 'propose' }).then(
      () => {
        throw new Error(`Round ${String(turn.round)} was unexpectedly accepted.`);
      },
      (error) => error.message,
    );
    const records = await reportFeedback.readReportFeedback(path.join(copy.issueRoot, stage));
    const produced = records.filter((entry) => entry.record.kind === 'rejection');
    if (produced.length !== 1) {
      throw new Error(`Round ${String(turn.round)} did not retain exactly one rejection.`);
    }
    if (produced[0].record.output !== turn.output) {
      throw new Error(`Round ${String(turn.round)} rejection did not retain the exact output.`);
    }
    reproduction.push({
      round: turn.round,
      invocationId: turn.invocationId,
      reason: rejection,
      recordedReason: produced[0].record.reason,
      outputSha256: turn.outputSha256,
    });
    await rm(copy.directory, { recursive: true, force: true });
  }
  record('reproduction', reproduction);

  const rejectionRecords = turns.map((turn, index) => {
    const replay = reproduction[index];
    const attribution =
      `Preparation ${stage} author, round ${String(turn.round)} (route ${plan.route}), ` +
      `task KAN-76, task propose; original invocation ${turn.invocationId} at task/KAN-76 ` +
      `revision ${turn.capturedAtHead}, captured ${turn.startedAt}. ` +
      `Historical rejection recorded by ${turn.historical.file} ` +
      `(sha256 ${turn.historical.fileSha256}) at ${turn.historical.eventTimestamp}. ` +
      `Imported from the retained recovery evidence ${turn.recoveryCapture} ` +
      `(sha256 ${turn.recoveryCaptureSha256}).`;
    // The merged validator answers a different question than the historical invocation did; its
    // replay diagnostic is additional correction guidance, never the historical violated rule.
    const replayDiagnostic =
      replay.reason === turn.historical.reason
        ? null
        : 'Current merged StageAuthor replay diagnostic of the same returned bytes (additional ' +
          'correction guidance; the violated rule above is the historical rejection): ' +
          replay.reason;
    return {
      kind: 'rejection',
      scope,
      invocationId: turn.invocationId,
      operation: 'stage-author',
      profile: turn.profile,
      context: [attribution, replayDiagnostic].filter((part) => part !== null).join(' '),
      source: null,
      output: turn.output,
      reason: turn.historical.reason,
    };
  });
  for (const recordValue of rejectionRecords) {
    reportFeedback.reportFeedbackSchema.parse(recordValue);
  }

  // --- Rehearsal: the reconciled checkpoint resumes with the correction feedback supplied -----
  const copy = await disposableCheckpoint();
  const copyArea = path.join(copy.issueRoot, stage);
  const copyScope = { ...scope, area: copyArea };
  const written = [];
  for (const recordValue of rejectionRecords) {
    const ref = await reportFeedback.writeReportFeedbackRecord(copyArea, {
      ...recordValue,
      scope: copyScope,
    });
    written.push(ref.path);
  }
  const outstandingBefore = await reportFeedback.outstandingReportFeedback({
    areaRoot: copyArea,
    scope: copyScope,
  });
  if (outstandingBefore.length !== 2) {
    throw new Error(
      'The reconciled checkpoint does not present exactly two outstanding rejections.',
    );
  }
  const authorContexts = [];
  const author = createStageAuthor({
    selectionFile: copy.selectionFile,
    stage,
    git: adapter,
    publish: () => undefined,
    runner: scriptedRunner([conformingSkip], authorContexts),
  });
  const authorOutcome = await author({ task: 'propose' });
  const authorRecord = await readJson(
    path.join(copyArea, `artifacts/${String(round)}/author.json`),
  );
  const outstandingAfter = await reportFeedback.outstandingReportFeedback({
    areaRoot: copyArea,
    scope: copyScope,
  });
  const feedbackHistory = (await reportFeedback.readReportFeedback(copyArea)).map((entry) => ({
    path: entry.path,
    kind: entry.record.kind,
  }));
  const evaluatorContexts = [];
  const evaluator = createStageEvaluator({
    selectionFile: copy.selectionFile,
    stage,
    git: adapter,
    publish: () => undefined,
    runner: scriptedRunner([conformingEvaluation], evaluatorContexts),
  });
  const evaluationOutcome = await evaluator();
  const evaluationRecord = await readJson(
    path.join(copyArea, `artifacts/${String(round)}/evaluation.json`),
  );
  const authorContext = authorContexts.join('\n');
  const requiredContext = [
    'Outstanding report rejection',
    'rejected historical evidence',
    'Violated rule:',
    'Rejected output (exact returned bytes):',
    'A usable replacement must be returned through this same role',
  ];
  for (const turn of turns) {
    const parsed = JSON.parse(turn.output);
    requiredContext.push(turn.historical.reason, parsed.summary, parsed.skip.reason);
  }
  for (const entry of reproduction) {
    const turn = turns.find((candidate) => candidate.round === entry.round);
    if (turn.historical.reason !== entry.reason) {
      // A differing replay diagnostic must reach the author as additional correction guidance.
      requiredContext.push(entry.reason);
    }
  }
  for (const required of requiredContext) {
    if (!authorContext.includes(required)) {
      throw new Error(`The author context does not carry ${JSON.stringify(required)}.`);
    }
  }
  if (evaluationRecord.assessedRevision !== round) {
    throw new Error('The rehearsal evaluation did not assess the authored revision.');
  }
  record('rehearsal', {
    copy: copy.issueRoot,
    written,
    outstandingBefore: outstandingBefore.map((entry) => entry.path),
    authorContext,
    authorOutcome,
    authorRecord,
    outstandingAfter: outstandingAfter.map((entry) => entry.path),
    feedbackHistory,
    evaluatorContext: evaluatorContexts.join('\n'),
    evaluationOutcome,
    evaluationRecord,
  });
  await rm(copy.directory, { recursive: true, force: true });

  // --- Apply the reconciliation to the retained checkpoint ------------------------------------
  let applied = [];
  const superseded = [];
  if (apply) {
    const existing = await reportFeedback.readReportFeedback(areaRoot);
    for (const [index, recordValue] of rejectionRecords.entries()) {
      const already = existing.find(
        (entry) =>
          entry.record.kind === 'rejection' &&
          entry.record.invocationId === recordValue.invocationId,
      );
      if (already === undefined) {
        const ref = await reportFeedback.writeReportFeedbackRecord(areaRoot, recordValue);
        applied.push({ path: ref.path, state: 'written' });
        continue;
      }
      if (JSON.stringify(already.record) === JSON.stringify(recordValue)) {
        applied.push({ path: already.path, state: 'already-reconciled' });
        continue;
      }
      // The earlier round applied the merged replay diagnostic as if it were the historical rule.
      // Reconcile that record explicitly: its replaced bytes are preserved outside the owning area
      // and its content is replaced atomically, so the next invocation receives the attributable
      // rule without the inaccurate record staying outstanding.
      if (already.record.output !== recordValue.output) {
        throw new Error(
          `The retained rejection at ${already.path} does not retain the captured rejected ` +
            'output; review it before applying.',
        );
      }
      if (already.record.reason !== reproduction[index].reason) {
        throw new Error(
          `The retained rejection at ${already.path} states neither the historical rule nor the ` +
            'merged replay diagnostic this reconciliation replaces; review it before applying.',
        );
      }
      const before = await readFile(already.path);
      const preserved = await preserveSuperseded(already.path, before);
      await writeJsonAtomic(already.path, recordValue);
      superseded.push({
        path: already.path,
        preserved,
        previousReason: already.record.reason,
        reason: recordValue.reason,
        beforeSha256: sha256(before),
        afterSha256: sha256(await readFile(already.path)),
      });
      applied.push({ path: already.path, state: 'reconciled', preserved });
    }
    const readBack = await reportFeedback.readReportFeedback(areaRoot);
    for (const entry of readBack) {
      if (entry.record.kind === 'rejection' && entry.record.output === null) {
        throw new Error(`The reconciled rejection at ${entry.path} retains no output.`);
      }
    }
    const outstanding = await reportFeedback.outstandingReportFeedback({ areaRoot, scope });
    if (outstanding.length !== 2) {
      throw new Error(
        'The applied reconciliation does not present the two outstanding rejections.',
      );
    }
    for (const entry of outstanding) {
      const expected = rejectionRecords.find(
        (recordValue) => recordValue.invocationId === entry.record.invocationId,
      );
      if (expected === undefined) {
        throw new Error(
          `The outstanding rejection at ${entry.path} names no reconciled invocation.`,
        );
      }
      if (entry.record.reason !== expected.reason) {
        throw new Error(
          `The outstanding rejection at ${entry.path} does not state the historical rule: ` +
            entry.record.reason,
        );
      }
      if (entry.record.output !== expected.output) {
        throw new Error(
          `The outstanding rejection at ${entry.path} does not retain the captured output.`,
        );
      }
    }
    record(
      'readBack',
      readBack.map((entry) => ({
        path: entry.path,
        kind: entry.record.kind,
        reason: entry.record.kind === 'rejection' ? entry.record.reason : null,
      })),
    );
  }
  const snapshotAfter = {
    worktreeStatus: git('status', '--porcelain=v1').trim(),
    worktreeHead: git('rev-parse', 'HEAD').trim(),
    artifactsListing: (await readdir(path.join(areaRoot, 'artifacts'))).sort(),
    stateListing: (await readdir(path.join(areaRoot, 'state'))).sort(),
    parentListing: (await readdir(path.join(settings.workspaceRoot, 'parent'))).sort(),
    authorRound2Sha256: sha256(await readFile(path.join(areaRoot, 'artifacts/2/author.json'))),
    planSha256: sha256(await readFile(path.join(areaRoot, 'state/current-round.json'))),
    recoveryExecutionSha256: sha256(await readFile(recoveryRecordFile)),
    feedback: (await reportFeedback.readReportFeedback(areaRoot)).map((entry) => ({
      path: entry.path,
      kind: entry.record.kind,
      reason: entry.record.reason,
    })),
  };
  for (const key of [
    'worktreeStatus',
    'worktreeHead',
    'artifactsListing',
    'stateListing',
    'parentListing',
    'authorRound2Sha256',
    'planSha256',
    'recoveryExecutionSha256',
  ]) {
    if (JSON.stringify(snapshotBefore[key]) !== JSON.stringify(snapshotAfter[key])) {
      throw new Error(`The reconciliation changed the retained checkpoint (${key}).`);
    }
  }
  record('applied', applied);
  record('superseded', superseded);
  record('snapshotAfter', snapshotAfter);
  record('finishedAt', new Date().toISOString());

  await mkdir(settings.evidenceDir, { recursive: true });
  const evidenceFile = path.join(settings.evidenceDir, 'kan76-reconciliation.json');
  const previousEvidence = await preservePreviousEvidence(evidenceFile);
  record('previousEvidence', previousEvidence);
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  const summary = {
    evidence: evidenceFile,
    apply,
    applied,
    superseded,
    reasons: turns.map((turn, index) => ({
      round: turn.round,
      historical: turn.historical.reason,
      mergedReplay: reproduction[index].reason,
    })),
    authorOutcome,
    evaluationOutcome,
    evaluationAssessedRevision: evaluationRecord.assessedRevision,
    outstandingAfter: snapshotAfter.feedback.filter((entry) => entry.kind === 'rejection').length,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
