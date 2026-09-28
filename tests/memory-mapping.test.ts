/**
 * Deterministic hand-off mapping coverage: the real actions extract their own observations from
 * their producer-owned artifacts, prepare the documented retrieval queries and place the supplied
 * block in the agent's context. Memory itself is a controlled capability that records what it
 * received; the artifact storage is real.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../src/agent-runtime/index.js';
import type { ProcessCommand } from '../src/adapters/processes.js';
import { ok } from '../src/result.js';
import { createChallenger } from '../src/task-engine/actions/challenger/index.js';
import { createDevelop } from '../src/task-engine/actions/develop/index.js';
import { devArtifact } from '../src/task-engine/actions/develop/artifacts.js';
import type { MemoryContext } from '../src/task-engine/actions/memory.js';
import { createVerify } from '../src/task-engine/actions/verify/index.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { runnerOf } from './support/agent-runner.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { scriptedJira } from './support/jira.js';
import { recordingMemory, type RecordingMemory } from './support/memory.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  temporaryDirectories.push(root);
  return root;
}

/** The memory context one action receives, with its recording capability. */
function memoryContext(settings: {
  readonly root: string;
  readonly memory: RecordingMemory;
  readonly project?: string;
  readonly workflow?: string;
}): MemoryContext {
  return {
    memory: settings.memory,
    evidenceDirectory: path.join(settings.root, 'logs', 'memory'),
    project: settings.project ?? 'NEX',
    workflow: settings.workflow ?? 'finite-delivery',
  };
}

/** A controlled runtime that answers one invocation from the handler. */
function scriptedRuntime(handler: () => unknown): {
  readonly runtime: AgentRuntime;
  readonly contexts: string[];
} {
  const contexts: string[] = [];
  return {
    contexts,
    runtime: {
      run(_profile, _workspace, additionalContext) {
        contexts.push(additionalContext);
        return Promise.resolve(ok({ output: JSON.stringify(handler()) }));
      },
    },
  };
}

/** One development workspace with a review finding the developer must answer. */
async function developmentWorkspace(root: string): Promise<{
  readonly selectionFile: string;
  readonly events: EngineEvent[];
}> {
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', '1'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', '2'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'worktree'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'current-round.json'),
    `${JSON.stringify({ number: 2, profile: 'dev-a', reason: 'repair round' })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify({
      taskKey: 'NEX-1',
      repository: '/origin/repository.git',
      branch: 'task/NEX-1',
      baseRevision,
    })}\n`,
    'utf8',
  );
  const review = {
    profile: 'reviewer',
    headRevision,
    verdict: 'changesRequested',
    summary: 'The transport leaks credentials in diagnostics.',
    findings: [
      {
        id: 'F1',
        title: 'Credential appears in diagnostics',
        severity: 'blocking',
        basis: 'Diagnostics must not expose credentials.',
        evidence: 'the failure text echoed the header',
        impact: 'an operator secret leaks into logs',
        repairGuidance: 'redact before reporting',
        locations: [{ path: 'src/transport.ts', line: 12 }],
      },
    ],
    priorFindings: [],
  };
  await writeFile(
    path.join(workspaceRoot, 'artifacts', '1', 'review.json'),
    `${JSON.stringify(review)}\n`,
    'utf8',
  );
  const selectionFile = path.join(root, 'executions', 'selection.json');
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeFile(
    selectionFile,
    `${JSON.stringify({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: { id: '1', key: 'NEX-1', fields: { summary: 'stale' } },
      conversation: [],
      workspace: { root: workspaceRoot },
    })}\n`,
    'utf8',
  );
  return { selectionFile, events: [] };
}

describe('develop hand-off mapping', () => {
  it('prepares the repair query, places the supplied block and observes summary and responses', async () => {
    const root = await temporaryRoot('nexus-mapping-develop-');
    const memory = recordingMemory();
    memory.setBlock('Historical evidence from earlier Nexus hand-offs (agent memory).');
    const workspace = await developmentWorkspace(root);
    const runtime = scriptedRuntime(() => ({
      status: 'completed',
      summary: 'Redacted the transport diagnostics and covered it with a test.',
      findingResponses: [
        {
          findingId: 'F1',
          status: 'addressed',
          response: 'Diagnostics now redact the credential before shortening.',
        },
      ],
    }));
    const events: EngineEvent[] = [];
    const jira = scriptedJira({
      readIssue: () =>
        ok({
          id: '1',
          key: 'NEX-1',
          fields: {
            summary: 'Integrate agent memory into Nexus workflows',
            description: {
              type: 'doc',
              version: 1,
              content: [{ type: 'text', text: 'bounded recall' }],
            },
          },
        }),
      readComments: () => ok([]),
    }).jira;
    const develop = createDevelop({
      selectionFile: workspace.selectionFile,
      runner: runnerOf(runtime.runtime),
      git: scriptedGit([
        repositoryState({ branch: 'task/NEX-1', headRevision, trackedChanges: false }),
      ]).git,
      jira,
      publish: (event) => events.push(event),
      memory: memoryContext({ root, memory }),
    });

    const outcome = await develop();
    expect(outcome).toBe('completed');

    expect(memory.recalls).toHaveLength(1);
    const query = memory.recalls[0]?.query ?? '';
    expect(query).toContain('role: developer');
    expect(query).toContain('project: NEX');
    expect(query).toContain('task summary: Integrate agent memory into Nexus workflows');
    expect(query).toContain('task description: bounded recall');
    expect(query).toContain('"id":"F1"');
    const evidenceFile = memory.recalls[0]?.evidenceFile ?? '';
    expect(path.basename(evidenceFile)).toBe(`${memory.recalls[0]?.invocationId ?? ''}.json`);

    // The supplied block reaches the invocation context exactly once.
    const context = runtime.contexts[0] ?? '';
    expect(context).toContain('Historical evidence from earlier Nexus hand-offs (agent memory).');
    expect(memory.observations).toHaveLength(2);
    const [summary, response] = memory.observations;
    expect(summary?.content).toContain('role developer, round 2, outcome completed');
    expect(summary?.content).toContain('Development summary: Redacted the transport diagnostics');
    expect(summary?.provenance).toMatchObject({
      project: 'NEX',
      issue: 'NEX-1',
      workflow: 'finite-delivery',
      role: 'developer',
      element: 'summary',
      round: 2,
      revision: headRevision,
    });
    expect(response?.provenance['element']).toBe('finding-response:F1');
    expect(response?.content).toContain('Finding response (addressed) to finding "F1"');
    expect(response?.content).toContain('Credential appears in diagnostics');
    expect(response?.content).toContain('the failure text echoed the header');

    // The response's source key names the artifact, the element selector and a content digest.
    expect(response?.sourceKey).toContain(
      'artifacts/2/development.json#finding-response:F1#sha256:',
    );
  });
});

/** The verify workspace an identity or excerpt assertion runs against. */
async function setupVerifyWorkspace(workspaceRoot: string): Promise<void> {
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'current-round.json'),
    `${JSON.stringify({ number: 1, profile: 'dev-a', reason: 'round' })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify({
      taskKey: 'NEX-1',
      repository: '/origin/repository.git',
      branch: 'task/NEX-1',
      baseRevision,
    })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'artifacts', '1', devArtifact.pathFromArtifactsRoot),
    `${JSON.stringify({
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'implemented',
      findingResponses: [],
    })}\n`,
    'utf8',
  );
}

/** Run the real Verify over one workspace, failing the second check with the supplied diagnostics. */
async function runVerify(
  settings: {
    readonly root: string;
    readonly workspaceRoot: string;
    readonly memory: RecordingMemory;
  },
  diagnostics: { readonly stdout: string; readonly stderr: string },
): Promise<readonly import('../src/memory/index.js').Observation[]> {
  const commands: ProcessCommand[] = [];
  const observed = settings.memory.observations.length;
  const verify = createVerify({
    workspace: { root: settings.workspaceRoot },
    checks: [
      { name: 'unit', command: { executable: 'npm', args: ['test'] } },
      { name: 'validate', command: { executable: 'npm', args: ['run', 'validate'] } },
    ],
    environment: {},
    git: scriptedGit([
      repositoryState({ branch: 'task/NEX-1', headRevision, trackedChanges: false }),
    ]).git,
    runCommand: (command, onOutput) => {
      const index = commands.length;
      commands.push(command);
      if (index === 0) {
        onOutput({ stream: 'stdout', chunk: Buffer.from('all good') });
      } else {
        if (diagnostics.stdout !== '') {
          onOutput({ stream: 'stdout', chunk: Buffer.from(diagnostics.stdout) });
        }
        if (diagnostics.stderr !== '') {
          onOutput({ stream: 'stderr', chunk: Buffer.from(diagnostics.stderr) });
        }
      }
      return Promise.resolve(ok({ exitCode: index === 0 ? 0 : 1 }));
    },
    publish: () => undefined,
    memory: memoryContext({ root: settings.root, memory: settings.memory }),
  });
  expect(await verify()).toBe('failed');
  return settings.memory.observations.slice(observed);
}

describe('verify hand-off mapping', () => {
  it('observes only failed checks with a bounded, marked diagnostic excerpt', async () => {
    const root = await temporaryRoot('nexus-mapping-verify-');
    const memory = recordingMemory();
    const workspaceRoot = path.join(root, 'workspace');
    await setupVerifyWorkspace(workspaceRoot);
    const observations = await runVerify(
      { root, workspaceRoot, memory },
      { stdout: `start-${'a'.repeat(2500)}`, stderr: `${'b'.repeat(2500)}-end` },
    );

    expect(observations).toHaveLength(1);
    const note = observations[0];
    expect(note?.provenance).toMatchObject({
      role: 'verification',
      element: 'check:1',
      round: 1,
      revision: headRevision,
    });
    expect(note?.provenance['references']).toEqual([
      expect.stringContaining('checks/1/stdout.log'),
      expect.stringContaining('checks/1/stderr.log'),
    ]);
    expect(note?.content).toContain('Check "validate" failed with exit code 1.');
    expect(note?.content).toContain('Command: npm run validate');
    // First and last characters are retained, the omission is marked and the logs are referenced.
    expect(note?.content).toContain(`start-${'a'.repeat(100)}`);
    expect(note?.content).toContain(`${'b'.repeat(100)}-end`);
    expect(note?.content).toMatch(/\[omitted \d+ characters\]/);
    expect(note?.content).toContain('stdout log:');
    expect(note?.content).toContain('checks/1/stderr.log');
  });

  it('keeps one source key for identical content and a new key when only the logs change', async () => {
    const root = await temporaryRoot('nexus-mapping-identity-');
    const memory = recordingMemory();
    const workspaceRoot = path.join(root, 'workspace');
    await setupVerifyWorkspace(workspaceRoot);
    const first = await runVerify(
      { root, workspaceRoot, memory },
      { stdout: 'the same artifact\nfailure one', stderr: '' },
    );
    const second = await runVerify(
      { root, workspaceRoot, memory },
      { stdout: 'the same artifact\nfailure one', stderr: '' },
    );
    const changed = await runVerify(
      { root, workspaceRoot, memory },
      { stdout: 'the same artifact\nfailure two', stderr: '' },
    );

    expect(first[0]?.sourceKey).toBe(second[0]?.sourceKey);
    expect(changed[0]?.sourceKey).not.toBe(first[0]?.sourceKey);
    // The validated verification.json is identical in all three runs; only the excerpt changed.
    expect(first[0]?.content).not.toBe(changed[0]?.content);
  });
});

describe('idea hand-off mapping', () => {
  it('observes a Challenger assessment bound to the revision it reviewed', async () => {
    const root = await temporaryRoot('nexus-mapping-challenger-');
    const memory = recordingMemory();
    const plan = {
      submission: 1,
      cycle: 1,
      route: 'new',
      profiles: { challenger: 'nexus-challenger' },
    };
    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeFile(
      path.join(root, 'state', 'current-round.json'),
      `${JSON.stringify(plan)}\n`,
      'utf8',
    );
    const submissionRoot = path.join(root, 'artifacts', 'submissions', '1');
    await mkdir(path.join(submissionRoot, 'cycles', '1'), { recursive: true });
    await writeFile(
      path.join(submissionRoot, 'input.json'),
      `${JSON.stringify({
        taskKey: 'NEX-2',
        source: { kind: 'jira', issueId: '2' },
        issue: { id: '2', key: 'NEX-2', fields: { summary: 'Add a lint gate' } },
        conversation: [{ id: 'c1', body: { text: 'the author\u2019s idea' } }],
      })}\n`,
      'utf8',
    );
    const refinedIdeaFile = path.join(submissionRoot, 'cycles', '1', 'refined-idea.json');
    await writeFile(
      refinedIdeaFile,
      `${JSON.stringify({
        idea: 'Add a lint gate so reviews stay on behaviour.',
        projectFit: 'The project already runs checks in CI.',
        feasibility: 'Adopt a small lint configuration.',
        changeSummary: 'Initial refinement.',
        revision: 1,
        submission: 1,
        cycle: 1,
      })}\n`,
      'utf8',
    );
    const runtime = scriptedRuntime(() => ({
      verdict: 'discuss',
      assessment: 'The gate is useful, but the scope is unclear.',
      obstacle: 'It is unclear which directories the gate covers.',
      concerns: [
        {
          concern: 'Scope is unclear',
          consequence: 'the gate may fail on generated code',
          resolution: 'name the covered directories',
        },
      ],
      suggestions: [],
    }));
    const challenger = createChallenger({
      workspace: { root },
      runner: runnerOf(runtime.runtime),
      publish: () => undefined,
      memory: memoryContext({ root, memory, project: 'NEX', workflow: 'idea-refinement' }),
    });

    expect(await challenger()).toBe('discuss');
    const query = memory.recalls[0]?.query ?? '';
    expect(query).toContain('role: challenger');
    expect(query).toContain('workflow: idea-refinement');
    expect(query).toContain('task summary: Add a lint gate');
    expect(query).toContain('current refined idea revision (1)');
    expect(memory.observations).toHaveLength(1);
    const note = memory.observations[0];
    expect(note?.provenance).toMatchObject({
      project: 'NEX',
      issue: 'NEX-2',
      workflow: 'idea-refinement',
      role: 'challenger',
      element: 'assessment',
      submission: 1,
      cycle: 1,
      revision: 1,
    });
    expect(note?.content).toContain('outcome discuss');
    expect(note?.content).toContain('Assessment: The gate is useful');
    expect(note?.content).toContain('Scope is unclear');
    expect(note?.content).toContain(`Assessed refined idea revision: ${refinedIdeaFile}`);
    expect(note?.content).toContain('Assessed editor response: none; the revision stood alone');
  });
});
