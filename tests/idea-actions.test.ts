/**
 * Focused integration tests: the four idea refinement role actions and the decision publication
 * over a temporary refinement area. The agent runtime and Jira source are controlled; the
 * artifact storage is real. They establish the context every role receives, the produced
 * artifacts, the Challenger's binding to one refined idea revision and editor response, and the
 * four source-updating publication routes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../src/agent-runtime/index.js';
import type { JiraComment, JiraTransition } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import {
  challengerArtifact,
  challengerReportSchema,
  challengerResponseSchema,
} from '../src/task-engine/actions/challenger/artifacts.js';
import { createChallenger } from '../src/task-engine/actions/challenger/index.js';
import {
  editorHelpArtifact,
  editorResponseArtifact,
  editorTurnResponseSchema,
  framingArtifact,
  framingResponseSchema,
  refinedIdeaArtifact,
  refinedIdeaSchema,
  type EditorTurnResponse,
} from '../src/task-engine/actions/idea-editor/artifacts.js';
import {
  createIdeaEditor,
  refinedIdeaDeliverableInstruction,
} from '../src/task-engine/actions/idea-editor/index.js';
import {
  ideaAttributionText,
  ideaCommunicationText,
  ideaDefinitionText,
  ideaSourceScopeText,
  ideaStageGuidanceText,
  projectGuidanceInstruction,
} from '../src/task-engine/actions/idea-context.js';
import {
  ideaCycleDirectory,
  ideaSubmissionInputFile,
} from '../src/task-engine/actions/idea-storage.js';
import {
  projectGuideArtifact,
  projectGuideFollowUpArtifact,
} from '../src/task-engine/actions/project-guide/artifacts.js';
import { createProjectGuide } from '../src/task-engine/actions/project-guide/index.js';
import {
  decisionArtifact,
  ideaHandoffFile,
  type IdeaDecisionRecord,
  type IdeaHandoff,
} from '../src/task-engine/actions/publish-decision/artifacts.js';
import { createPublishDecision } from '../src/task-engine/actions/publish-decision/index.js';
import {
  researchArtifact,
  researchFollowUpArtifact,
  researchResponseSchema,
} from '../src/task-engine/actions/researcher/artifacts.js';
import { createResearcher } from '../src/task-engine/actions/researcher/index.js';
import type { IdeaSelection } from '../src/task-engine/actions/select-idea/artifacts.js';
import {
  ideaRoundPlanFile,
  type IdeaRoundPlan,
} from '../src/task-engine/actions/start-idea-round/artifacts.js';
import { runnerOf } from './support/agent-runner.js';
import { scriptedJira } from './support/jira.js';
import { recordingMemory } from './support/memory.js';
import { strictSchemaProblems } from './support/provider-schema.js';

const profiles = {
  'idea-editor': 'nexus-editor',
  researcher: 'nexus-research',
  'project-guide': 'nexus-guide',
  challenger: 'nexus-challenger',
} as const;

const capturedInput = {
  taskKey: 'NEX-1',
  source: { kind: 'jira' as const, issueId: '10518' },
  issue: {
    id: '10518',
    key: 'NEX-1',
    fields: { summary: 'Add a lint gate', description: { type: 'doc', version: 1, content: [] } },
  },
  conversation: [{ id: 'c1', body: { text: 'the author\u2019s idea' } }],
};

const framingFixture = {
  framing: 'The author proposes a lint gate so reviews can stay on behaviour.',
  questions: ['Is generated code in scope?'],
  authorDecision: null,
};

const researchFixture = {
  contribution: 'Linters keep reviews focused on behaviour.',
  findings: ['Teams catch style defects early.'],
  options: ['Adopt the smallest lint configuration that covers the repository.'],
  sources: [{ title: 'Lint overview', link: 'https://example.com/lint', accessed: '2026-09-24' }],
};

const guidanceFixture = {
  contribution: 'The project already enforces checks in CI, so a gate fits.',
  fit: 'The project wants reviewers focused on behaviour.',
  steering: ['Keep the scope small.'],
  constraints: ['Checks must stay fast.'],
  evidence: ['docs/purpose.md'],
  provisional: true,
  uncertainty: ['The charter is incomplete.'],
};

/** One editor turn that writes the supplied revision. */
function revisedTurn(
  revision: number,
  openQuestions: string[] | null = ['Is generated code in scope?'],
): EditorTurnResponse {
  return {
    disposition: 'revised',
    response: `I wrote the smallest lint gate (revision ${String(revision)}).`,
    reason: null,
    help: null,
    refinedIdea: {
      idea: 'Reviewers spend time on style defects; a lint gate would keep reviews on behaviour.',
      projectFit: 'The project already enforces checks in CI.',
      feasibility: `Enable the smallest lint gate first (revision ${String(revision)}).`,
      openQuestions,
      changeSummary: `Refined idea revision ${String(revision)}.`,
    },
  };
}

/** One editor turn that answers a concern without changing the refined idea. */
function answeredTurn(): EditorTurnResponse {
  return {
    disposition: 'answered',
    response: 'The gate runs on staged files only, so the checks stay fast.',
    reason: null,
    help: null,
    refinedIdea: null,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** The text of one published comment document. */
function commentText(document: unknown): string {
  const content =
    typeof document === 'object' && document !== null
      ? (document as { readonly content?: readonly { readonly content?: unknown }[] }).content
      : undefined;
  return (content ?? [])
    .flatMap((paragraph) => {
      const text = paragraph.content;
      return Array.isArray(text)
        ? text.flatMap((node) =>
            typeof (node as { readonly text?: unknown }).text === 'string'
              ? [(node as { readonly text: string }).text]
              : [],
          )
        : [];
    })
    .join('\n');
}

/** One refinement area with the supplied plan, captured input and project guidance. */
async function refinementArea(options?: {
  readonly submission?: number;
  readonly cycle?: number;
  readonly route?: IdeaRoundPlan['route'];
  readonly guidance?: string | null;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-idea-action-'));
  temporaryDirectories.push(root);
  const plan: IdeaRoundPlan = {
    submission: options?.submission ?? 1,
    cycle: options?.cycle ?? 1,
    route: options?.route ?? 'new',
    profiles,
  };
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, ideaRoundPlanFile), JSON.stringify(plan));
  const inputFile = ideaSubmissionInputFile(root, plan.submission);
  await mkdir(path.dirname(inputFile), { recursive: true });
  await writeFile(inputFile, JSON.stringify(capturedInput));
  const worktree = path.join(root, 'worktree');
  await mkdir(worktree, { recursive: true });
  if (options?.guidance !== null) {
    await writeFile(
      path.join(worktree, 'AGENTS.md'),
      options?.guidance ?? '# Project instructions\n\nPrefer the smallest change.\n',
    );
  }
  const events: EngineEvent[] = [];
  return {
    root,
    plan,
    worktree,
    events,
    cycleRoot: (cycle = plan.cycle) => ideaCycleDirectory(root, plan.submission, cycle),
    async write(cycle: number, relative: string, value: unknown) {
      const file = path.join(ideaCycleDirectory(root, plan.submission, cycle), relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value));
      return file;
    },
    async read<Value>(cycle: number, relative: string): Promise<Value> {
      return JSON.parse(
        await readFile(
          path.join(ideaCycleDirectory(root, plan.submission, cycle), relative),
          'utf8',
        ),
      ) as Value;
    },
    async exists(relative: string): Promise<boolean> {
      try {
        await readFile(path.join(root, relative), 'utf8');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** A controlled agent runtime answering each invocation with the supplied response. */
function scriptedRuntime(outputs: readonly unknown[]): {
  readonly runtime: AgentRuntime;
  readonly requests: {
    readonly profile: string;
    readonly workspace: string;
    readonly context: string;
    readonly outputSchema: Readonly<Record<string, unknown>> | undefined;
  }[];
} {
  const requests: {
    readonly profile: string;
    readonly workspace: string;
    readonly context: string;
    readonly outputSchema: Readonly<Record<string, unknown>> | undefined;
  }[] = [];
  let index = 0;
  return {
    requests,
    runtime: {
      async run(profile, workspace, context, _onActivity, outputSchema) {
        requests.push({ profile, workspace: workspace.root, context, outputSchema });
        const output = outputs[index];
        index += 1;
        return output === undefined
          ? { ok: false, fault: { message: 'No scripted agent output remains.' } }
          : ok({ output: JSON.stringify(output) });
      },
    },
  };
}

/** The shared idea context every role invocation must carry exactly once. */
function expectSharedContext(context: string): void {
  for (const shared of [
    ideaDefinitionText,
    ideaStageGuidanceText,
    ideaAttributionText,
    ideaSourceScopeText,
    ideaCommunicationText,
  ]) {
    expect(context.split(shared)).toHaveLength(2);
  }
}

describe('idea editor', () => {
  it('frames the captured idea with the project guidance and records the framing', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([framingFixture]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'frame' })).resolves.toBe('framed');

    const request = agent.requests[0];
    expect(request?.profile).toBe('nexus-editor');
    expect(request?.workspace).toBe(area.root);
    expect(request?.outputSchema).toEqual(z.toJSONSchema(framingResponseSchema));
    expect(strictSchemaProblems(request?.outputSchema)).toEqual([]);
    expectSharedContext(request?.context ?? '');
    expect(request?.context).toContain('Add a lint gate');
    expect(request?.context).toContain('the author\u2019s idea');
    expect(request?.context).toContain('Prefer the smallest change.');
    expect(request?.context).toContain(projectGuidanceInstruction);
    expect(request?.context).toContain(path.join(area.root, 'worktree'));
    expect(await area.read(1, framingArtifact.pathFromArtifactsRoot)).toEqual(framingFixture);
    expect(area.events.at(-1)).toMatchObject({
      source: 'idea-editor',
      type: 'outcome',
      data: { outcome: 'framed', cycle: 1, detail: '1 questions' },
    });
  });

  it('asks the author when an essential decision is missing', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([
      {
        framing: 'The author asks for faster checks but not how much coverage they want.',
        questions: [],
        authorDecision: { question: 'Which repositories must the gate cover at launch?' },
      },
    ]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'frame' })).resolves.toBe('author-decision-needed');
  });

  it('writes the refined idea revision from both contributions', async () => {
    const area = await refinementArea();
    await area.write(1, researchArtifact.pathFromArtifactsRoot, {
      ...researchFixture,
      role: 'researcher',
      question: null,
    });
    await area.write(1, projectGuideArtifact.pathFromArtifactsRoot, {
      ...guidanceFixture,
      role: 'project-guide',
      question: null,
    });
    const agent = scriptedRuntime([revisedTurn(1)]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'edit' })).resolves.toBe('written');

    const request = agent.requests[0];
    expect(request?.context).toContain('Linters keep reviews focused on behaviour.');
    expect(request?.context).toContain('a gate fits');
    expect(request?.context.split(refinedIdeaDeliverableInstruction)).toHaveLength(2);
    expect(request?.outputSchema).toEqual(z.toJSONSchema(editorTurnResponseSchema));
    const stored = await area.read(1, refinedIdeaArtifact.pathFromArtifactsRoot);
    expect(refinedIdeaSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({ revision: 1, submission: 1, cycle: 1 });
  });

  it('refuses to write the refined idea without both contributions', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([revisedTurn(1)]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'edit' })).rejects.toThrow(/contribution/u);
    expect(agent.requests).toEqual([]);
  });

  it('reuses the response it already wrote for the cycle', async () => {
    const area = await refinementArea();
    await area.write(1, researchArtifact.pathFromArtifactsRoot, {
      ...researchFixture,
      role: 'researcher',
      question: null,
    });
    await area.write(1, projectGuideArtifact.pathFromArtifactsRoot, {
      ...guidanceFixture,
      role: 'project-guide',
      question: null,
    });
    const agent = scriptedRuntime([revisedTurn(1)]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'edit' })).resolves.toBe('written');
    await expect(editor({ task: 'edit' })).resolves.toBe('written');

    expect(agent.requests).toHaveLength(1);
  });

  it('answers a concern without changing the refined idea text', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(2, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'discuss',
      assessment: 'The speed concern is unresolved.',
      obstacle: 'The idea may slow everyday work without saying how it stays fast.',
      concerns: [
        {
          concern: 'The gate may slow local work.',
          consequence: 'Developers would disable it.',
          resolution: 'Show that the gate runs on changed files only.',
        },
      ],
      suggestions: [],
      refinedIdea: revision,
      editorResponse: null,
      revision: 1,
    });
    const agent = scriptedRuntime([answeredTurn()]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'respond' })).resolves.toBe('responded');

    expect(agent.requests[0]?.context).toContain('The gate may slow local work.');
    expect(agent.requests[0]?.context.split(refinedIdeaDeliverableInstruction)).toHaveLength(2);
    expect(await area.read(2, editorResponseArtifact.pathFromArtifactsRoot)).toMatchObject({
      disposition: 'answered',
      reason: null,
    });
    // The answer leaves the revision in force: no new revision artifact exists for cycle 2.
    await expect(area.exists('artifacts/submissions/1/cycles/2/refined-idea.json')).resolves.toBe(
      false,
    );
  });

  it('requests focused help with the specific questions it needs answered', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(2, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'discuss',
      assessment: 'The evidence is thin.',
      obstacle: 'Nothing yet shows the gate is worth the change.',
      concerns: [
        {
          concern: 'No evidence that lint gates reduce review time.',
          consequence: 'The value claim is unsubstantiated.',
          resolution: 'Cite a study or a comparable project.',
        },
      ],
      suggestions: [],
      refinedIdea: revision,
      editorResponse: null,
      revision: 1,
    });
    const agent = scriptedRuntime([
      {
        disposition: 'help-requested',
        response: 'I need evidence on review time before I can answer.',
        reason: null,
        help: { researcher: 'What evidence links lint gates to review time?', projectGuide: null },
        refinedIdea: null,
      },
    ]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'respond' })).resolves.toBe('help-requested');

    expect(await area.read(2, editorHelpArtifact.pathFromArtifactsRoot)).toMatchObject({
      disposition: 'help-requested',
      help: { researcher: 'What evidence links lint gates to review time?', projectGuide: null },
    });
  });

  it('rebuts a mistaken objection without changing the refined idea text', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(2, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'discuss',
      assessment: 'The objection misreads the idea.',
      obstacle: 'The idea looks broader than it is; its scope should be clear before pursuit.',
      concerns: [
        {
          concern: 'The gate must cover every repository.',
          consequence: 'That scope is not plausible.',
          resolution: 'Narrow the promise.',
        },
      ],
      suggestions: [],
      refinedIdea: revision,
      editorResponse: null,
      revision: 1,
    });
    const agent = scriptedRuntime([
      {
        disposition: 'rebutted',
        response: 'The idea never claims repository-wide coverage; the objection misreads it.',
        reason: null,
        help: null,
        refinedIdea: null,
      },
    ]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'respond' })).resolves.toBe('responded');

    expect(await area.read(2, editorResponseArtifact.pathFromArtifactsRoot)).toMatchObject({
      disposition: 'rebutted',
    });
    await expect(area.exists('artifacts/submissions/1/cycles/2/refined-idea.json')).resolves.toBe(
      false,
    );
  });

  it('gives the editor the connected project guidance when it answers a concern', async () => {
    const area = await refinementArea({
      cycle: 2,
      route: 'next',
      guidance: '# Project instructions\n\nPrefer the smallest change that fulfils the purpose.\n',
    });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(2, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'discuss',
      assessment: 'The speed concern is unresolved.',
      obstacle: 'The idea may slow everyday work without saying how it stays fast.',
      concerns: [
        {
          concern: 'The gate may slow local work.',
          consequence: 'Developers would disable it.',
          resolution: 'Show that the gate runs on changed files only.',
        },
      ],
      suggestions: [],
      refinedIdea: revision,
      editorResponse: null,
      revision: 1,
    });
    const agent = scriptedRuntime([answeredTurn()]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'respond' })).resolves.toBe('responded');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain('Prefer the smallest change that fulfils the purpose.');
    expect(context).toContain(projectGuidanceInstruction);
    expect(context.split(projectGuidanceInstruction)).toHaveLength(2);
  });

  it.each(['edit', 'respond', 'respond-after-help'] as const)(
    'recovers a coherent %s turn after a response write fails',
    async (task) => {
      const cycle = task === 'edit' ? 1 : 2;
      const area = await refinementArea({ cycle, route: cycle === 1 ? 'new' : 'next' });
      await area.write(1, researchArtifact.pathFromArtifactsRoot, {
        ...researchFixture,
        role: 'researcher',
        question: null,
      });
      await area.write(1, projectGuideArtifact.pathFromArtifactsRoot, {
        ...guidanceFixture,
        role: 'project-guide',
        question: null,
      });
      let previous: string | null = null;
      if (cycle === 2) {
        previous = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
          ...revisedTurn(1).refinedIdea,
          revision: 1,
          submission: 1,
          cycle: 1,
        });
        await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
          verdict: 'discuss',
          assessment: 'The scope may make checks too slow.',
          obstacle: 'The gate needs a plausible way to keep checks fast.',
          concerns: [
            {
              concern: 'Checking every file may be slow.',
              consequence: 'Developers may disable it.',
              resolution: 'Consider limiting checks to changed files.',
            },
          ],
          suggestions: [],
          refinedIdea: previous,
          editorResponse: null,
          revision: 1,
        });
      }
      if (task === 'respond-after-help') {
        await area.write(cycle, editorHelpArtifact.pathFromArtifactsRoot, {
          disposition: 'help-requested',
          response: 'Can full source checks stay fast?',
          reason: null,
          help: { researcher: 'Can full source checks stay fast?', projectGuide: null },
        });
        await area.write(cycle, researchFollowUpArtifact.pathFromArtifactsRoot, {
          ...researchFixture,
          role: 'researcher',
          question: 'Can full source checks stay fast?',
        });
      }
      const content = {
        idea: 'Run the lint gate on all source files.',
        projectFit: 'Keep reviews focused on behaviour.',
        feasibility: 'Use incremental caching to keep full source checks fast.',
        openQuestions: null,
        changeSummary: 'Added caching while retaining full source coverage.',
      };
      const original = {
        ...revisedTurn(cycle),
        refinedIdea: content,
        response: 'The gate still checks all source files; caching may address the speed concern.',
      };
      const changed = {
        ...original,
        refinedIdea: { ...content, idea: 'Run the lint gate on changed source files only.' },
        response: 'I narrowed the gate to changed source files only.',
      };
      const recovered = {
        ...original,
        refinedIdea: { ...content, openQuestions: [] },
        response:
          'The saved revision retains all source files and proposes caching; speed remains uncertain.',
      };
      const invalidDispositions: EditorTurnResponse[] =
        task === 'edit'
          ? []
          : [
              answeredTurn(),
              {
                disposition: 'author-decision-needed',
                response: 'The author must choose the scope.',
                reason: 'Which files should be checked?',
                help: null,
                refinedIdea: null,
              },
              ...(task === 'respond'
                ? [
                    {
                      disposition: 'help-requested' as const,
                      response: 'More research is needed.',
                      reason: null,
                      help: { researcher: 'Which files should be checked?', projectGuide: null },
                      refinedIdea: null,
                    },
                  ]
                : []),
            ];
      const agent = scriptedRuntime([original, changed, ...invalidDispositions, recovered]);
      const responseFile = path.join(
        area.cycleRoot(),
        editorResponseArtifact.pathFromArtifactsRoot,
      );
      const revisionFile = path.join(area.cycleRoot(), refinedIdeaArtifact.pathFromArtifactsRoot);
      const editor = createIdeaEditor({
        workspace: { root: area.root },
        runner: runnerOf({
          async run(...args) {
            const result = await agent.runtime.run(...args);
            // Obstruct the response write only after the action has read its existing outputs.
            if (agent.requests.length === 1) await mkdir(responseFile, { recursive: true });
            return result;
          },
        }),
        publish: (event) => area.events.push(event),
      });
      await expect(editor({ task })).rejects.toThrow(/could not be written/u);
      const savedRevision = await readFile(revisionFile, 'utf8');
      await rm(responseFile, { recursive: true });

      // A materially different retry cannot silently lose its change and save its commentary.
      for (let attempt = 0; attempt <= invalidDispositions.length; attempt += 1) {
        await expect(editor({ task })).rejects.toThrow(/must complete the retained revision/u);
        await expect(readFile(responseFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(revisionFile, 'utf8')).toBe(savedRevision);
        expect(area.events).toEqual([]);
      }
      const recoveryContext = agent.requests[1]?.context ?? '';
      expect(recoveryContext).toContain('Interrupted editor turn recovery');
      expect(recoveryContext).toContain('repeat its content exactly');
      expect(recoveryContext).toContain('Run the lint gate on all source files.');
      if (previous !== null) {
        expect(recoveryContext).toContain(
          `The refined idea revision the Challenger assessed: ${previous}`,
        );
        expect(recoveryContext).toContain(
          `The refined idea revision currently in force: ${revisionFile}`,
        );
      }

      const outcome = task === 'edit' ? 'written' : 'responded';
      await expect(editor({ task })).resolves.toBe(outcome);
      await expect(editor({ task })).resolves.toBe(outcome);
      expect(agent.requests).toHaveLength(3 + invalidDispositions.length);
      expect(await readFile(revisionFile, 'utf8')).toBe(savedRevision);
      expect(await area.read(cycle, editorResponseArtifact.pathFromArtifactsRoot)).toMatchObject({
        disposition: 'revised',
        response: recovered.response,
      });

      const challengerAgent = scriptedRuntime([
        {
          verdict: 'approve',
          assessment: 'Caching is a plausible approach, with speed still uncertain.',
          obstacle: null,
          concerns: [],
          suggestions: [],
        },
      ]);
      const challenger = createChallenger({
        workspace: { root: area.root },
        runner: runnerOf(challengerAgent.runtime),
        publish: (event) => area.events.push(event),
      });
      await expect(challenger()).resolves.toBe('approve');
      const context = challengerAgent.requests[0]?.context ?? '';
      expect(context).toContain(content.idea);
      expect(context).toContain(recovered.response);
      expect(context).not.toContain(changed.refinedIdea.idea);
      expect(context).not.toContain(changed.response);
      expect(context).not.toContain('The revision stands alone');
      expect(await area.read(cycle, challengerArtifact.pathFromArtifactsRoot)).toMatchObject({
        refinedIdea: revisionFile,
        editorResponse: responseFile,
        revision: cycle,
      });
    },
  );
});

describe('Researcher and Project guide', () => {
  it('researches the idea and records the contribution with its sources', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([researchFixture]);
    const researcher = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(researcher({ phase: 'initial' })).resolves.toBe('contributed');

    const request = agent.requests[0];
    expect(request?.profile).toBe('nexus-research');
    expect(request?.outputSchema).toEqual(z.toJSONSchema(researchResponseSchema));
    expect(strictSchemaProblems(request?.outputSchema)).toEqual([]);
    expectSharedContext(request?.context ?? '');
    expect(request?.context).toContain('the author\u2019s idea');
    expect(request?.context).toContain('Prefer the smallest change.');
    expect(await area.read(1, researchArtifact.pathFromArtifactsRoot)).toEqual({
      ...researchFixture,
      role: 'researcher',
      question: null,
    });
    expect(area.events.at(-1)).toMatchObject({
      source: 'researcher',
      type: 'outcome',
      data: { outcome: 'contributed', detail: '1 source' },
    });
  });

  it('answers the editor’s focused question and skips a request aimed elsewhere', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(2, editorHelpArtifact.pathFromArtifactsRoot, {
      disposition: 'help-requested',
      response: 'I need evidence.',
      reason: null,
      help: { researcher: null, projectGuide: 'Which documented constraint matters most?' },
    });
    const agent = scriptedRuntime([guidanceFixture]);
    const researcherMemory = recordingMemory();
    const guideMemory = recordingMemory();
    const researcher = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
      memory: {
        memory: researcherMemory,
        evidenceDirectory: path.join(area.root, 'logs', 'memory'),
        project: 'NEX',
        workflow: 'idea-refinement',
      },
    });
    const guide = createProjectGuide({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
      memory: {
        memory: guideMemory,
        evidenceDirectory: path.join(area.root, 'logs', 'memory'),
        project: 'NEX',
        workflow: 'idea-refinement',
      },
    });

    // The editor asked the Project guide only; the Researcher contributes nothing.
    await expect(researcher({ phase: 'focused' })).resolves.toBe('not-requested');
    await expect(guide({ phase: 'focused' })).resolves.toBe('contributed');
    // The skipped role recalled nothing; the answering role recalled with the focused question and
    // observed its contribution bound to that question.
    expect(researcherMemory.recalls).toEqual([]);
    expect(researcherMemory.observations).toEqual([]);
    expect(guideMemory.recalls).toHaveLength(1);
    expect(guideMemory.recalls[0]?.query).toContain('role: project-guide');
    expect(guideMemory.recalls[0]?.query).toContain(
      'assigned focused question: Which documented constraint matters most?',
    );
    expect(guideMemory.observations).toHaveLength(1);
    expect(guideMemory.observations[0]?.content).toContain(
      'Focused question answered: Which documented constraint matters most?',
    );
    expect(guideMemory.observations[0]?.provenance).toMatchObject({
      project: 'NEX',
      workflow: 'idea-refinement',
      role: 'project-guide',
      element: 'contribution',
      submission: 1,
      cycle: 2,
    });

    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0]?.context).toContain('Which documented constraint matters most?');
    expectSharedContext(agent.requests[0]?.context ?? '');
    // The focused contribution still receives the refined idea revision in force directly.
    expect(agent.requests[0]?.context).toContain('a lint gate would keep reviews on behaviour');
    expect(await area.read(2, projectGuideFollowUpArtifact.pathFromArtifactsRoot)).toEqual({
      ...guidanceFixture,
      role: 'project-guide',
      question: 'Which documented constraint matters most?',
    });
    await expect(
      area.exists(
        path.join(
          'artifacts/submissions/1/cycles/2',
          researchFollowUpArtifact.pathFromArtifactsRoot,
        ),
      ),
    ).resolves.toBe(false);
  });

  it('carries the shared source-scope guidance into a focused researcher turn', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(2, editorHelpArtifact.pathFromArtifactsRoot, {
      disposition: 'help-requested',
      response: 'I need evidence.',
      reason: null,
      help: { researcher: 'What evidence links lint gates to review time?', projectGuide: null },
    });
    const agent = scriptedRuntime([researchFixture]);
    const researcher = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(researcher({ phase: 'focused' })).resolves.toBe('contributed');

    const context = agent.requests[0]?.context ?? '';
    expectSharedContext(context);
    expect(context).toContain('What evidence links lint gates to review time?');
    expect(context.indexOf(ideaSourceScopeText)).toBeLessThan(
      context.indexOf('Current captured idea'),
    );
    expect(await area.read(2, researchFollowUpArtifact.pathFromArtifactsRoot)).toEqual({
      ...researchFixture,
      role: 'researcher',
      question: 'What evidence links lint gates to review time?',
    });
  });

  it('reports provisional project direction from the connected project', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([guidanceFixture]);
    const guide = createProjectGuide({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(guide({ phase: 'initial' })).resolves.toBe('contributed');

    expect(agent.requests[0]?.profile).toBe('nexus-guide');
    expect(agent.requests[0]?.context).toContain('Find the project\u2019s purpose');
    expect(await area.read(1, projectGuideArtifact.pathFromArtifactsRoot)).toEqual({
      ...guidanceFixture,
      role: 'project-guide',
      question: null,
    });
    expect(area.events.at(-1)).toMatchObject({
      source: 'project-guide',
      type: 'outcome',
      data: { outcome: 'contributed', detail: 'provisional project direction' },
    });
  });
});

describe('challenger', () => {
  it('binds its result to the exact revision and editor response it reviewed', async () => {
    const area = await refinementArea();
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    const agent = scriptedRuntime([
      {
        verdict: 'approve',
        assessment: 'There is a plausible way forward.',
        obstacle: null,
        concerns: [],
        suggestions: ['Cover generated files later.'],
      },
    ]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(challenger()).resolves.toBe('approve');

    const request = agent.requests[0];
    expect(request?.profile).toBe('nexus-challenger');
    expect(request?.outputSchema).toEqual(z.toJSONSchema(challengerResponseSchema));
    expect(strictSchemaProblems(request?.outputSchema)).toEqual([]);
    expectSharedContext(request?.context ?? '');
    expect(request?.context).toContain('Reviewers spend time on style defects');
    const stored = await area.read(1, challengerArtifact.pathFromArtifactsRoot);
    expect(challengerReportSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({
      verdict: 'approve',
      refinedIdea: revision,
      editorResponse: null,
      revision: 1,
    });
    expect(area.events.at(-1)).toMatchObject({
      source: 'challenger',
      type: 'outcome',
      data: { outcome: 'approve' },
    });
  });

  it('reuses its saved result for the same revision and response', async () => {
    const area = await refinementArea();
    await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    const agent = scriptedRuntime([
      { verdict: 'approve', assessment: 'Fine.', obstacle: null, concerns: [], suggestions: [] },
    ]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(challenger()).resolves.toBe('approve');
    await expect(challenger()).resolves.toBe('approve');

    expect(agent.requests).toHaveLength(1);
  });

  it('discusses a changed revision even when the earlier result approved', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const first = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'approve',
      assessment: 'Approved.',
      obstacle: null,
      concerns: [],
      suggestions: [],
      refinedIdea: first,
      editorResponse: null,
      revision: 1,
    });
    const revision = await area.write(2, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(2).refinedIdea,
      openQuestions: undefined,
      revision: 2,
      submission: 1,
      cycle: 2,
    });
    const agent = scriptedRuntime([
      {
        verdict: 'discuss',
        assessment: 'The revised scope is broader than the evidence supports.',
        obstacle: 'The revised idea promises more coverage than the evidence supports.',
        concerns: [
          {
            concern: 'The revision promises repository-wide coverage.',
            consequence: 'The promise exceeds the stated need.',
            resolution: 'Limit the first revision to changed files.',
          },
        ],
        suggestions: [],
      },
    ]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(challenger()).resolves.toBe('discuss');

    expect(agent.requests[0]?.context).toContain('revision 2');
    expect(await area.read(2, challengerArtifact.pathFromArtifactsRoot)).toMatchObject({
      verdict: 'discuss',
      refinedIdea: revision,
      revision: 2,
    });
  });

  it('rejects an approval with unresolved concerns and a discussion without any', async () => {
    const area = await refinementArea();
    await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    const failing = scriptedRuntime([
      {
        verdict: 'approve',
        assessment: 'Approved with a concern.',
        obstacle: null,
        concerns: [{ concern: 'Scope', consequence: 'Broad', resolution: 'Narrow it' }],
        suggestions: [],
      },
    ]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(failing.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(challenger()).rejects.toThrow(/unresolved concerns/u);
    await expect(area.exists('artifacts/submissions/1/cycles/1/challenger.json')).resolves.toBe(
      false,
    );
  });

  it('requires the author-facing obstacle on a discussion', async () => {
    const area = await refinementArea();
    await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    const agent = scriptedRuntime([
      {
        verdict: 'discuss',
        assessment: 'The value concern stands.',
        obstacle: null,
        concerns: [
          {
            concern: 'No evidence links lint gates to shorter reviews.',
            consequence: 'The value claim is unsubstantiated.',
            resolution: 'Cite a comparable project.',
          },
        ],
        suggestions: [],
      },
    ]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(challenger()).rejects.toThrow(/remaining obstacle/u);
    expect(agent.requests[0]?.context).toContain('state the remaining obstacle plainly');
    await expect(area.exists('artifacts/submissions/1/cycles/1/challenger.json')).resolves.toBe(
      false,
    );
  });
});

describe('decision publication', () => {
  /** One retained selection with the two publication transitions the active status permits. */
  const selection: IdeaSelection = {
    taskKey: 'NEX-1',
    source: { kind: 'jira', issueId: '10518' },
    issue: capturedInput.issue,
    conversation: [{ id: 'c1', body: { text: 'the author\u2019s idea' } }],
    transitions: {
      toActive: { id: '11', name: 'Start refinement', to: { id: '2', name: 'Idea Refinement' } },
      fromActive: [
        { id: '21', name: 'Approve', to: { id: '3', name: 'Draft' } },
        { id: '22', name: 'Request feedback', to: { id: '4', name: 'Waiting for Feedback' } },
      ] satisfies JiraTransition[],
    },
    claimed: true,
    retainedSubmissions: 0,
    workspace: { root: '' },
    issueWorkspace: { root: '' },
  };

  /** A controlled source recording comments and transitions. */
  function source() {
    const comments: JiraComment[] = [];
    const transitions: string[] = [];
    const scripted = scriptedJira({
      addComment: (_issueId, body) => {
        const comment = { id: `c${String(comments.length + 2)}`, body };
        comments.push(comment);
        return ok(comment);
      },
      transitionIssue: (_issueId, transitionId) => {
        transitions.push(transitionId);
        return ok(undefined);
      },
    });
    return { jira: scripted.jira, calls: scripted.calls, comments, transitions };
  }

  /** One publication over the supplied refinement area and controlled source. */
  function publication(
    area: Awaited<ReturnType<typeof refinementArea>>,
    jira: ReturnType<typeof source>,
  ) {
    return createPublishDecision({
      selection: {
        ...selection,
        workspace: { root: area.root },
        issueWorkspace: { root: path.join(area.root, '..', 'NEX-1') },
      },
      statuses: {
        submitted: 'Idea',
        approved: 'Draft',
        waitingForFeedback: 'Waiting for Feedback',
      },
      jira: jira.jira,
      publish: (event) => area.events.push(event),
    });
  }

  /** One approval-ready cycle: contributions, a revision, a response and an approving Challenger. */
  async function approvedCycle(area: Awaited<ReturnType<typeof refinementArea>>) {
    await area.write(1, framingArtifact.pathFromArtifactsRoot, framingFixture);
    await area.write(1, researchArtifact.pathFromArtifactsRoot, {
      ...researchFixture,
      role: 'researcher',
      question: null,
    });
    await area.write(1, projectGuideArtifact.pathFromArtifactsRoot, {
      ...guidanceFixture,
      role: 'project-guide',
      question: null,
    });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    const response = await area.write(1, editorResponseArtifact.pathFromArtifactsRoot, {
      disposition: 'revised',
      response: 'I wrote the smallest lint gate.',
      reason: null,
      help: null,
    });
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'approve',
      assessment: 'Plausible way forward.',
      obstacle: null,
      concerns: [],
      suggestions: [],
      refinedIdea: revision,
      editorResponse: response,
      revision: 1,
    });
    return revision;
  }

  it('publishes the approved refined idea, moves the item and leaves a handoff of references', async () => {
    const area = await refinementArea();
    const revision = await approvedCycle(area);
    const jira = source();

    await expect(publication(area, jira)({ decision: 'approved' })).resolves.toBe('approved');

    // Publication uses the captured snapshot: no issue or comment read reaches Jira.
    expect(jira.calls.some((call) => call.startsWith('read:'))).toBe(false);
    expect(jira.calls.some((call) => call.startsWith('comments:'))).toBe(false);
    expect(jira.transitions).toEqual(['21']);
    expect(jira.comments).toHaveLength(1);
    const published = commentText(jira.comments[0]?.body);
    expect(published).toContain('Approved refined idea (revision 1)');
    expect(published).toContain('Project fit: The project already enforces checks in CI.');
    expect(published).toContain('Conversation cycles used: 1');
    expect(published).toContain('What refinement changed: Refined idea revision 1.');
    expect(published).not.toContain('Plausible way forward.');

    const decision = JSON.parse(
      await readFile(
        path.join(area.root, 'artifacts/submissions/1', decisionArtifact.pathFromArtifactsRoot),
        'utf8',
      ),
    ) as IdeaDecisionRecord;
    expect(decision).toMatchObject({
      decision: 'approved',
      refinedIdea: revision,
      revision: 1,
      reason: null,
      source: { transition: { id: '21', to: 'Draft' }, status: 'Draft', commentId: 'c2' },
    });
    const handoff = JSON.parse(
      await readFile(path.join(area.root, ideaHandoffFile), 'utf8'),
    ) as IdeaHandoff;
    expect(handoff).toMatchObject({
      issue: { id: '10518', key: 'NEX-1' },
      capturedInput: ideaSubmissionInputFile(area.root, 1),
      refinedIdea: revision,
    });
    expect(handoff.contributions).toHaveLength(2);
    expect(handoff.challengerResults).toEqual([
      path.join(area.cycleRoot(), challengerArtifact.pathFromArtifactsRoot),
    ]);
    expect(handoff.framing).toBe(
      path.join(area.cycleRoot(), framingArtifact.pathFromArtifactsRoot),
    );
  });

  it('returns an unsuitable idea with the plain reason and the latest idea', async () => {
    const area = await refinementArea();
    await area.write(1, framingArtifact.pathFromArtifactsRoot, framingFixture);
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(1, editorResponseArtifact.pathFromArtifactsRoot, {
      disposition: 'unsuitable',
      response: 'This does not look worth pursuing.',
      reason: 'The project already checks style in its editor, so the gate adds little.',
      help: null,
    });
    const jira = source();

    await expect(publication(area, jira)({ decision: 'unsuitable' })).resolves.toBe(
      'waiting-for-feedback',
    );

    expect(jira.transitions).toEqual(['22']);
    const published = commentText(jira.comments[0]?.body);
    expect(published).toContain('Returned for feedback: this idea does not look suitable');
    expect(published).toContain('Latest refined idea (revision 1)');
    expect(published).toContain('Conversation cycles used: 1');
    expect(published).toContain('Why it was returned:');
    expect(published).toContain('The project already checks style in its editor');
    expect(published).toContain('to "Idea" to resubmit it');
    expect(published).not.toContain('This does not look worth pursuing.');
    expect(await area.exists('artifacts/handoff.json')).toBe(false);
    const decision = JSON.parse(
      await readFile(
        path.join(area.root, 'artifacts/submissions/1', decisionArtifact.pathFromArtifactsRoot),
        'utf8',
      ),
    ) as IdeaDecisionRecord;
    expect(decision).toMatchObject({
      decision: 'unsuitable',
      refinedIdea: revision,
      editor: path.join(area.cycleRoot(), editorResponseArtifact.pathFromArtifactsRoot),
    });
  });

  it('asks the author for the essential decision when the framing found one', async () => {
    const area = await refinementArea();
    await area.write(1, framingArtifact.pathFromArtifactsRoot, {
      framing: 'The author wants faster checks without saying how far they should reach.',
      questions: [],
      authorDecision: { question: 'Which repositories must the gate cover at launch?' },
    });
    const jira = source();

    await expect(publication(area, jira)({ decision: 'author-decision-needed' })).resolves.toBe(
      'waiting-for-feedback',
    );

    const published = commentText(jira.comments[0]?.body);
    expect(published).toContain('Author decision needed');
    expect(published).toContain('Captured idea (no refined idea revision yet)');
    expect(published).toContain('Add a lint gate');
    expect(published).toContain('Which repositories must the gate cover at launch?');
    // A return that stopped at the framing still reports what refinement reached.
    expect(published).toContain(
      'What refinement changed: The editor framed the author\u2019s proposal shown above; ' +
        'refinement stopped before a refined idea revision was written.',
    );
    expect(published).not.toContain('Conversation cycles used: 0');
    expect(jira.transitions).toEqual(['22']);
  });

  it('reports exhausted attempts with the author-facing obstacle and no internal concerns', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    const response = await area.write(2, editorResponseArtifact.pathFromArtifactsRoot, {
      disposition: 'answered',
      response: 'The gate runs on changed files only.',
      reason: null,
      help: null,
    });
    await area.write(2, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'discuss',
      assessment: 'The answer does not resolve the value concern.',
      obstacle: 'Nothing yet shows the gate is worth the change.',
      concerns: [
        {
          concern: 'src/task-engine/actions/verify/index.ts shows the value claim lacks evidence.',
          consequence: 'The idea may not be worth developing.',
          resolution: 'Cite comparable projects in the refined idea, not in the answer.',
        },
      ],
      suggestions: [],
      refinedIdea: revision,
      editorResponse: response,
      revision: 1,
    });
    const jira = source();

    await expect(publication(area, jira)({ decision: 'attempts-exhausted' })).resolves.toBe(
      'waiting-for-feedback',
    );

    const published = commentText(jira.comments[0]?.body);
    expect(published).toContain('Attempts exhausted after 2 cycles');
    expect(published).toContain('Conversation cycles used: 2');
    expect(published).toContain('What refinement changed: Refined idea revision 1.');
    expect(published).toContain('Nothing yet shows the gate is worth the change.');
    // The internal concerns and their editor-directed resolutions stay in the artifact.
    expect(published).not.toContain('verify/index.ts');
    expect(published).not.toContain('Cite comparable projects in the refined idea');
    expect(published).not.toContain('The answer does not resolve the value concern.');
    const decision = JSON.parse(
      await readFile(
        path.join(area.root, 'artifacts/submissions/1', decisionArtifact.pathFromArtifactsRoot),
        'utf8',
      ),
    ) as IdeaDecisionRecord;
    expect(decision).toMatchObject({
      decision: 'attempts-exhausted',
      revision: 1,
      reason: 'Nothing yet shows the gate is worth the change.',
      challenger: path.join(area.cycleRoot(2), challengerArtifact.pathFromArtifactsRoot),
    });
  });

  it('refuses an exhausted return without a plain statement of the remaining obstacle', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(2, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'discuss',
      assessment: 'A concern remains.',
      obstacle: null,
      concerns: [
        {
          concern: 'The value claim still lacks evidence.',
          consequence: 'The idea may not be worth developing.',
          resolution: 'Cite comparable projects.',
        },
      ],
      suggestions: [],
      refinedIdea: revision,
      editorResponse: null,
      revision: 1,
    });
    const jira = source();

    await expect(publication(area, jira)({ decision: 'attempts-exhausted' })).rejects.toThrow(
      /remaining obstacle/u,
    );
    expect(jira.comments).toEqual([]);
  });

  it('reuses a decision it already recorded instead of publishing again', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    const jira = source();
    const decide = publication(area, jira);

    await expect(decide({ decision: 'approved' })).resolves.toBe('approved');
    await expect(decide({ decision: 'approved' })).resolves.toBe('approved');

    expect(jira.comments).toHaveLength(1);
    expect(jira.transitions).toEqual(['21']);
  });

  it('refuses an approval the Challenger did not grant for this exact revision', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    // A Challenger result bound to another revision cannot authorize publication.
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
      verdict: 'approve',
      assessment: 'Approved elsewhere.',
      obstacle: null,
      concerns: [],
      suggestions: [],
      refinedIdea: path.join(area.cycleRoot(), 'another-revision.json'),
      editorResponse: null,
      revision: 1,
    });
    const jira = source();

    await expect(publication(area, jira)({ decision: 'approved' })).rejects.toThrow(
      /exact refined idea revision/u,
    );
    expect(jira.comments).toEqual([]);
  });

  it('refuses an unsuitable return the editor did not explain', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    const jira = source();

    await expect(publication(area, jira)({ decision: 'unsuitable' })).rejects.toThrow(
      /unsuitable/u,
    );
    expect(jira.comments).toEqual([]);
  });

  it('reports a refined idea that the first edit found unsuitable without a revision', async () => {
    const area = await refinementArea();
    await area.write(1, framingArtifact.pathFromArtifactsRoot, {
      framing: 'The author proposes a gate the project already applies in its editor.',
      questions: [],
      authorDecision: null,
    });
    await area.write(1, editorResponseArtifact.pathFromArtifactsRoot, {
      disposition: 'unsuitable',
      response: 'The gate adds little here.',
      reason: 'The project already runs the same checks in the editor.',
      help: null,
    });
    const jira = source();

    await expect(publication(area, jira)({ decision: 'unsuitable' })).resolves.toBe(
      'waiting-for-feedback',
    );

    const published = commentText(jira.comments[0]?.body);
    expect(published).toContain('Captured idea (no refined idea revision yet)');
    expect(published).toContain('The editor\u2019s framing of it:');
    expect(published).toContain('The project already runs the same checks in the editor.');
    expect(published).toContain(
      'What refinement changed: The editor framed the author\u2019s proposal shown above; ' +
        'refinement stopped before a refined idea revision was written.',
    );
  });
});
