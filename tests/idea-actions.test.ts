/**
 * Focused integration tests: the four idea refinement role actions and the decision publication
 * over a temporary refinement area. The agent runtime and Jira source are controlled; the
 * artifact storage is real. They establish the context every role receives, the produced
 * artifacts, the Challenger's binding to one refined idea revision and editor response, and the
 * four source-updating publication routes.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  legacyChallengerArtifact,
} from '../src/task-engine/actions/challenger/artifacts.js';
import { createChallenger } from '../src/task-engine/actions/challenger/index.js';
import {
  editorHelpArtifact,
  editorResponseArtifact,
  editorTurnResponseSchema,
  framingArtifact,
  framingResponseSchema,
  readRefinedIdeaRevision,
  refinedIdeaArtifact,
  refinedIdeaIdentity,
  refinedIdeaSchema,
  type EditorTurnResponse,
} from '../src/task-engine/actions/idea-editor/artifacts.js';
import {
  createIdeaEditor,
  refinedIdeaDeliverableInstruction,
} from '../src/task-engine/actions/idea-editor/index.js';
import {
  capturedIdeaText,
  ideaAttributionText,
  ideaCommunicationText,
  ideaDefinitionText,
  ideaSourceScopeText,
  ideaStageGuidanceText,
  projectGuidanceInstruction,
  retainedHistoryText,
} from '../src/task-engine/actions/idea-context.js';
import {
  ideaCycleDirectory,
  ideaSubmissionInputFile,
} from '../src/task-engine/actions/idea-storage.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  recordIdentity,
  readReportFeedback,
} from '../src/task-engine/actions/report-feedback.js';
import {
  projectGuideArtifact,
  projectGuideFollowUpArtifact,
} from '../src/task-engine/actions/project-guide/artifacts.js';
import { createProjectGuide } from '../src/task-engine/actions/project-guide/index.js';
import {
  ideaHandoffFile,
  type IdeaDecisionRecord,
  type IdeaHandoff,
} from '../src/task-engine/actions/publish-decision/artifacts.js';
import {
  createPublishDecision,
  createRecordIdeaDecision,
} from '../src/task-engine/actions/publish-decision/index.js';
import {
  researchArtifact,
  researchFollowUpArtifact,
  researchResponseSchema,
} from '../src/task-engine/actions/researcher/artifacts.js';
import { createResearcher } from '../src/task-engine/actions/researcher/index.js';
import {
  ideaRoundPlanFile,
  type IdeaRoundPlan,
} from '../src/task-engine/actions/start-idea-round/artifacts.js';
import { runnerOf, writeAssignedReport } from './support/agent-runner.js';
import { scriptedJira } from './support/jira.js';
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

/** The researcher provider response: completion alone; its narrative is the Markdown report. */
const researchResponse = {};

/** The research Markdown a controlled researcher writes to its assigned report. */
const researchReport = [
  'Contribution: Linters keep reviews focused on behaviour.',
  '',
  'Findings:',
  '- Teams catch style defects early.',
  '',
  'Options:',
  '- Adopt the smallest lint configuration that covers the repository.',
  '',
  'Sources:',
  '- Lint overview: https://example.com/lint (accessed 2026-09-24)',
].join('\n');

/** The project guide provider response: completion alone; its narrative is the Markdown report. */
const guidanceResponse = {};

/** The guidance Markdown a controlled project guide writes to its assigned report. */
const guidanceReport = [
  'Contribution: The project already enforces checks in CI, so a gate fits.',
  '',
  'Project fit: The project wants reviewers focused on behaviour.',
  '',
  'Steering:',
  '- Keep the scope small.',
  '',
  'Constraints:',
  '- Checks must stay fast.',
  '',
  'Evidence:',
  '- docs/purpose.md',
  '',
  'Uncertainty:',
  '- The charter is incomplete.',
].join('\n');

/** One editor turn that writes the supplied revision. */
function revisedTurn(
  revision: number,
  openQuestions: string[] | null = ['Is generated code in scope?'],
): EditorTurnResponse {
  return {
    disposition: 'revised',
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

/**
 * The published comment text of one decision record. The parent publication publishes the exact
 * text the child's record retained.
 */
function commentText(record: { readonly comment: string }): string {
  return record.comment;
}

/** One refinement area with the supplied plan, captured input and project guidance. */
async function refinementArea(options?: {
  readonly submission?: number;
  readonly cycle?: number;
  readonly route?: IdeaRoundPlan['route'];
  readonly guidance?: string | null;
}) {
  const issueRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-idea-action-'));
  temporaryDirectories.push(issueRoot);
  const root = path.join(issueRoot, 'refinement');
  await mkdir(root, { recursive: true });
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
    /**
     * Write one current saved outcome with its bound Markdown report, as the action does: the
     * record carries the observed attribution and the report path, byte identity and invocation.
     */
    async writeReported(
      cycle: number,
      relative: string,
      record: Record<string, unknown>,
      markdown: string,
      invocationId: string,
    ): Promise<string> {
      const reportFile = path.join(
        ideaCycleDirectory(root, plan.submission, cycle),
        'reports',
        invocationId,
        `${path.basename(relative, '.json')}.md`,
      );
      await mkdir(path.dirname(reportFile), { recursive: true });
      await writeFile(reportFile, markdown, 'utf8');
      const file = path.join(ideaCycleDirectory(root, plan.submission, cycle), relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          ...record,
          report: { path: reportFile },
          invocationId,
        }),
      );
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

type RefinementArea = Awaited<ReturnType<typeof refinementArea>>;

/** Write one cycle's bound research contribution with the controlled Markdown report. */
async function writeResearch(
  area: RefinementArea,
  cycle = area.plan.cycle,
  question: string | null = null,
): Promise<string> {
  return area.writeReported(
    cycle,
    researchArtifact.pathFromArtifactsRoot,
    {
      taskKey: capturedInput.taskKey,
      role: 'researcher',
      profile: profiles.researcher,
      question,
    },
    researchReport,
    `researcher-${String(cycle)}`,
  );
}

/** Write one cycle's bound project guidance contribution with the controlled Markdown report. */
async function writeGuidance(
  area: RefinementArea,
  cycle = area.plan.cycle,
  question: string | null = null,
): Promise<string> {
  return area.writeReported(
    cycle,
    projectGuideArtifact.pathFromArtifactsRoot,
    {
      taskKey: capturedInput.taskKey,
      role: 'project-guide',
      profile: profiles['project-guide'],
      question,
    },
    guidanceReport,
    `project-guide-${String(cycle)}`,
  );
}

/** Write one cycle's bound Challenger result with the Markdown report it assessed content in. */
async function writeChallenge(
  area: RefinementArea,
  settings: {
    readonly cycle?: number;
    readonly verdict: 'approve' | 'discuss';
    readonly obstacle: string | null;
    readonly markdown: string;
    readonly refinedIdea: string;
    readonly revision: number;
    readonly editorResponse?: string | null;
    readonly editorIdentity?: string | null;
    readonly invocationId?: string;
  },
): Promise<string> {
  const cycle = settings.cycle ?? area.plan.cycle;
  const read = await readRefinedIdeaRevision(
    ideaCycleDirectory(area.root, area.plan.submission, cycle),
  );
  if (read === null) {
    throw new Error('The challenge fixture needs a refined idea revision.');
  }
  return area.writeReported(
    cycle,
    challengerArtifact.pathFromArtifactsRoot,
    {
      taskKey: capturedInput.taskKey,
      role: 'challenger',
      profile: profiles.challenger,
      verdict: settings.verdict,
      obstacle: settings.obstacle,
      refinedIdea: settings.refinedIdea,
      refinedIdeaIdentity: refinedIdeaIdentity(read),
      editorResponse: settings.editorResponse ?? null,
      editorIdentity: settings.editorIdentity ?? null,
      revision: settings.revision,
    },
    settings.markdown,
    settings.invocationId ?? `challenger-${String(cycle)}`,
  );
}

/** The Markdown a controlled invocation writes to its assigned report when a test supplies none. */
const controlledReport = '# Controlled report\n\nThe controlled narrative.\n';

/**
 * A controlled agent runtime answering each invocation with the supplied response and writing the
 * assigned Markdown report its role must produce. The reports argument is one Markdown text for
 * every invocation, null to write nothing, or one entry per invocation.
 */
function scriptedRuntime(
  outputs: readonly unknown[],
  reports: string | null | readonly (string | null)[] = controlledReport,
): {
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
        const report =
          typeof reports === 'object' && reports !== null ? (reports[index] ?? null) : reports;
        index += 1;
        if (output === undefined) {
          return { ok: false, fault: { message: 'No scripted agent output remains.' } };
        }
        if (report !== null) {
          await writeAssignedReport(context, report);
        }
        return ok({ output: JSON.stringify(output) });
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
    const storedFraming = await area.read<{
      readonly report: { readonly path: string };
      readonly invocationId: string;
    }>(1, framingArtifact.pathFromArtifactsRoot);
    expect(storedFraming).toMatchObject({
      framing: framingFixture.framing,
      questions: framingFixture.questions,
      authorDecision: null,
      taskKey: 'NEX-1',
      role: 'idea-editor',
      profile: 'nexus-editor',
    });
    expect(await readFile(storedFraming.report.path, 'utf8')).toBe(controlledReport);
    expect(storedFraming).not.toHaveProperty('reportIdentity');
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
    await writeResearch(area);
    await writeGuidance(area);
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
    await writeResearch(area);
    await writeGuidance(area);
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

  it('keeps a reused editor turn bound to the Challenger result it answered', async () => {
    const area = await refinementArea();
    await writeResearch(area);
    await writeGuidance(area);
    const editing = scriptedRuntime([revisedTurn(1)]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(editing.runtime),
      publish: (event) => area.events.push(event),
    });
    await expect(editor({ task: 'edit' })).resolves.toBe('written');
    const turnFile = path.join(area.cycleRoot(), editorResponseArtifact.pathFromArtifactsRoot);
    const saved = await readFile(turnFile, 'utf8');

    // The cycle's own Challenger runs after the editor wrote; its assessment is not an answer to
    // this turn and cannot become one when the saved turn is reused.
    const challenging = scriptedRuntime([
      {
        verdict: 'discuss',
        obstacle: 'The idea may slow everyday work without saying how it stays fast.',
      },
    ]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(challenging.runtime),
      publish: (event) => area.events.push(event),
    });
    await expect(challenger()).resolves.toBe('discuss');

    await expect(editor({ task: 'edit' })).resolves.toBe('written');
    // Reuse neither invokes the editor again nor rewrites the turn it already saved.
    expect(editing.requests).toHaveLength(1);
    expect(await readFile(turnFile, 'utf8')).toBe(saved);
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
    // The Challenger that discussed revision 1 wrote its result into cycle 1; StartIdeaRound then
    // opened cycle 2, whose editor turn answers it.
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
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
    // The Challenger that discussed revision 1 wrote its result into cycle 1; the cycle-2 editor
    // turn it opened answers it.
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
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

  it('rejects an editor turn carrying parts its disposition does not own', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      openQuestions: undefined,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
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
    const help = {
      researcher: 'What evidence links lint gates to review time?',
      projectGuide: null,
    };
    const cases: readonly { readonly turn: unknown; readonly problem: RegExp }[] = [
      {
        turn: { ...revisedTurn(2), reason: 'The concern was already answered.' },
        problem: /reason only for an unsuitable or author-decision-needed return/u,
      },
      {
        turn: {
          disposition: 'answered',
          reason: null,
          help,
          refinedIdea: null,
        },
        problem: /help only for a help-requested turn/u,
      },
      {
        turn: {
          disposition: 'help-requested',
          reason: null,
          help,
          refinedIdea: revisedTurn(2).refinedIdea,
        },
        problem: /refinedIdea only for a revised turn/u,
      },
    ];
    for (const { turn, problem } of cases) {
      const editor = createIdeaEditor({
        workspace: { root: area.root },
        runner: runnerOf(scriptedRuntime([turn]).runtime),
        publish: (event) => area.events.push(event),
      });
      await expect(editor({ task: 'respond' })).rejects.toThrow(problem);
    }
    // Every contradictory turn stays rejected: none was normalized into a saved response.
    await expect(
      area.exists('artifacts/submissions/1/cycles/2/editor-response.json'),
    ).resolves.toBe(false);
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
    // The Challenger that discussed revision 1 wrote its result into cycle 1; the cycle-2 editor
    // turn it opened rebuts it.
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
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
    // The Challenger that discussed revision 1 wrote its result into cycle 1; the cycle-2 editor
    // turn it opened answers it.
    await area.write(1, challengerArtifact.pathFromArtifactsRoot, {
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
      await writeResearch(area);
      await writeGuidance(area);
      let previous: string | null = null;
      if (cycle === 2) {
        previous = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
          ...revisedTurn(1).refinedIdea,
          revision: 1,
          submission: 1,
          cycle: 1,
        });
        await writeChallenge(area, {
          cycle: 1,
          verdict: 'discuss',
          obstacle: 'The gate needs a plausible way to keep checks fast.',
          markdown: 'Checking every file may be slow.',
          refinedIdea: previous,
          revision: 1,
        });
      }
      if (task === 'respond-after-help') {
        await area.writeReported(
          cycle,
          editorHelpArtifact.pathFromArtifactsRoot,
          {
            taskKey: 'NEX-1',
            role: 'idea-editor',
            profile: 'nexus-editor',
            disposition: 'help-requested',
            reason: null,
            help: { researcher: 'Can full source checks stay fast?', projectGuide: null },
          },
          '# Editor help request\n',
          'editor-help-2',
        );
        await area.writeReported(
          cycle,
          researchFollowUpArtifact.pathFromArtifactsRoot,
          {
            taskKey: 'NEX-1',
            role: 'researcher',
            profile: 'nexus-research',
            question: 'Can full source checks stay fast?',
          },
          researchReport,
          'researcher-follow-up-2',
        );
      }
      const content = {
        idea: 'Run the lint gate on all source files.',
        projectFit: 'Keep reviews focused on behaviour.',
        feasibility: 'Use incremental caching to keep full source checks fast.',
        openQuestions: null,
        changeSummary: 'Added caching while retaining full source coverage.',
      };
      const originalMarkdown =
        'The gate still checks all source files; caching may address the speed concern.';
      const changedMarkdown = 'I narrowed the gate to changed source files only.';
      const recoveredMarkdown =
        'The saved revision retains all source files and proposes caching; speed remains uncertain.';
      const original = { ...revisedTurn(cycle), refinedIdea: content };
      const changed = {
        ...original,
        refinedIdea: { ...content, idea: 'Run the lint gate on changed source files only.' },
      };
      const recovered = {
        ...original,
        refinedIdea: { ...content, openQuestions: [] },
      };
      const invalidDispositions: EditorTurnResponse[] =
        task === 'edit'
          ? []
          : [
              answeredTurn(),
              {
                disposition: 'author-decision-needed',
                reason: 'Which files should be checked?',
                help: null,
                refinedIdea: null,
              },
              ...(task === 'respond'
                ? [
                    {
                      disposition: 'help-requested' as const,
                      reason: null,
                      help: { researcher: 'Which files should be checked?', projectGuide: null },
                      refinedIdea: null,
                    },
                  ]
                : []),
            ];
      const agent = scriptedRuntime(
        [original, changed, ...invalidDispositions, recovered],
        [
          originalMarkdown,
          changedMarkdown,
          ...invalidDispositions.map(() => controlledReport),
          recoveredMarkdown,
        ],
      );
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
      // Each conflicting retry is retained as rejection evidence of the editor-turn report, with
      // its exact output, so the reason survives an interrupted response write.
      const editorTurnScope = {
        project: projectOfWorkspace(path.dirname(area.root)),
        workId: 'NEX-1',
        area: area.root,
        role: 'idea-editor',
        reportKind: 'idea-editor-turn',
      };
      const conflicts = await outstandingReportFeedback({
        areaRoot: area.root,
        scope: editorTurnScope,
      });
      expect(conflicts).toHaveLength(invalidDispositions.length + 1);
      expect(conflicts.map((entry) => entry.record.reason)).toEqual(
        expect.arrayContaining([expect.stringContaining('must complete the retained revision')]),
      );
      expect(conflicts.map((entry) => entry.record.output)).toContain(JSON.stringify(changed));
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
      // The completing invocation received the retained rejections and its validated saved turn
      // recorded the corrections that retired them, while the rejection history stays readable.
      const completedContext = agent.requests.at(-1)?.context ?? '';
      expect(completedContext).toContain('Outstanding report rejection');
      expect(completedContext).toContain('must complete the retained revision');
      expect(completedContext).toContain(JSON.stringify(changed).slice(0, 40));
      await expect(
        outstandingReportFeedback({ areaRoot: area.root, scope: editorTurnScope }),
      ).resolves.toEqual([]);
      expect(
        (await readReportFeedback(area.root)).filter((entry) => entry.record.kind === 'rejection'),
      ).toHaveLength(invalidDispositions.length + 1);
      expect(await readFile(revisionFile, 'utf8')).toBe(savedRevision);
      const savedTurn = await area.read<{
        readonly report: { readonly path: string };
      }>(cycle, editorResponseArtifact.pathFromArtifactsRoot);
      expect(savedTurn).toMatchObject({
        disposition: 'revised',
      });
      expect(await readFile(savedTurn.report.path, 'utf8')).toBe(recoveredMarkdown);

      const challengerAgent = scriptedRuntime([
        {
          verdict: 'approve',
          obstacle: null,
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
      expect(context).toContain(recoveredMarkdown);
      expect(context).not.toContain(changed.refinedIdea.idea);
      expect(context).not.toContain(changedMarkdown);
      expect(context).not.toContain('The revision stands alone');
      expect(await area.read(cycle, challengerArtifact.pathFromArtifactsRoot)).toMatchObject({
        refinedIdea: revisionFile,
        editorResponse: responseFile,
        revision: cycle,
      });
    },
  );

  it('supplies the focused question as data beside the focused contribution Markdown', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const revision = await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await writeChallenge(area, {
      cycle: 1,
      verdict: 'discuss',
      obstacle: 'The gate may slow local work.',
      markdown: 'The speed concern is unresolved.',
      refinedIdea: revision,
      revision: 1,
    });
    await area.writeReported(
      2,
      editorHelpArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'idea-editor',
        profile: 'nexus-editor',
        disposition: 'help-requested',
        reason: null,
        help: { researcher: 'Can full source checks stay fast?', projectGuide: null },
      },
      '# Editor help request\n',
      'editor-help-2',
    );
    await area.writeReported(
      2,
      researchFollowUpArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'researcher',
        profile: 'nexus-research',
        question: 'Can full source checks stay fast?',
      },
      '# Focused research\n\nThe narrative reports the findings without restating the request.\n',
      'researcher-follow-up-2',
    );
    const agent = scriptedRuntime([answeredTurn()]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(editor({ task: 'respond-after-help' })).resolves.toBe('responded');

    // The question is functional outcome data, so the post-help turn receives it even though the
    // contribution's Markdown narrative does not restate it.
    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain('"question":"Can full source checks stay fast?"');
    // The retained-history reference for the same contribution stays readable as its outcome.
    expect(context).toContain('cycle 2 focused research: researcher, profile nexus-research');
  });
});

describe('Researcher and Project guide', () => {
  it('researches the idea and records the contribution with its sources', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([researchResponse], researchReport);
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
    const stored = await area.read<{
      readonly report: { readonly path: string };
    }>(1, researchArtifact.pathFromArtifactsRoot);
    expect(stored).toMatchObject({
      taskKey: 'NEX-1',
      role: 'researcher',
      profile: 'nexus-research',
      question: null,
    });
    expect(await readFile(stored.report.path, 'utf8')).toBe(researchReport);
    expect(stored).not.toHaveProperty('reportIdentity');
    expect(area.events.at(-1)).toMatchObject({
      source: 'researcher',
      type: 'outcome',
      data: { outcome: 'contributed', detail: null },
    });
  });

  it('supplies the saved framing interpretation as data beside its Markdown narrative', async () => {
    const area = await refinementArea();
    await area.writeReported(
      1,
      framingArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'idea-editor',
        profile: 'nexus-editor',
        framing: 'The author wants a gate framed as a change to review practice.',
        questions: ['Is generated code in scope?'],
        authorDecision: null,
      },
      '# Framing narrative\n\nThe narrative omits the functional interpretation.\n',
      'editor-framing-1',
    );
    const agent = scriptedRuntime([researchResponse], researchReport);
    const researcher = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(researcher({ phase: 'initial' })).resolves.toBe('contributed');

    // The functional framing reaches the invocation through the framing outcome, not through its
    // Markdown narrative.
    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain('The author wants a gate framed as a change to review practice.');
    expect(context).toContain('"questions":["Is generated code in scope?"]');
    expect(context).toContain('functional data: {"framing":');
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
    await area.writeReported(
      2,
      editorHelpArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'idea-editor',
        profile: 'nexus-editor',
        disposition: 'help-requested',
        reason: null,
        help: { researcher: null, projectGuide: 'Which documented constraint matters most?' },
      },
      '# Editor help request\n',
      'editor-help-2',
    );
    const agent = scriptedRuntime([guidanceResponse], guidanceReport);
    const researcher = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });
    const guide = createProjectGuide({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    // The editor asked the Project guide only; the Researcher contributes nothing.
    await expect(researcher({ phase: 'focused' })).resolves.toBe('not-requested');
    await expect(guide({ phase: 'focused' })).resolves.toBe('contributed');
    // Only the role the question addressed ran one invocation.
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0]?.context).toContain('Which documented constraint matters most?');
    expectSharedContext(agent.requests[0]?.context ?? '');
    // The focused contribution still receives the refined idea revision in force directly.
    expect(agent.requests[0]?.context).toContain('a lint gate would keep reviews on behaviour');
    expect(await area.read(2, projectGuideFollowUpArtifact.pathFromArtifactsRoot)).toMatchObject({
      taskKey: 'NEX-1',
      role: 'project-guide',
      profile: 'nexus-guide',
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
    await area.writeReported(
      2,
      editorHelpArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'idea-editor',
        profile: 'nexus-editor',
        disposition: 'help-requested',
        reason: null,
        help: { researcher: 'What evidence links lint gates to review time?', projectGuide: null },
      },
      '# Editor help request\n',
      'editor-help-2',
    );
    const agent = scriptedRuntime([researchResponse], researchReport);
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
    expect(await area.read(2, researchFollowUpArtifact.pathFromArtifactsRoot)).toMatchObject({
      taskKey: 'NEX-1',
      role: 'researcher',
      profile: 'nexus-research',
      question: 'What evidence links lint gates to review time?',
    });
  });

  it('reports provisional project direction from the connected project', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([guidanceResponse], guidanceReport);
    const guide = createProjectGuide({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(guide({ phase: 'initial' })).resolves.toBe('contributed');

    expect(agent.requests[0]?.profile).toBe('nexus-guide');
    expect(agent.requests[0]?.context).toContain('Find the project\u2019s purpose');
    expect(await area.read(1, projectGuideArtifact.pathFromArtifactsRoot)).toMatchObject({
      taskKey: 'NEX-1',
      role: 'project-guide',
      profile: 'nexus-guide',
      question: null,
    });
    expect(area.events.at(-1)).toMatchObject({
      source: 'project-guide',
      type: 'outcome',
      data: { outcome: 'contributed', detail: null },
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
        obstacle: null,
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
    const stored = await area.read<{
      readonly report: { readonly path: string };
      readonly refinedIdeaIdentity: string;
    }>(1, challengerArtifact.pathFromArtifactsRoot);
    expect(challengerReportSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({
      verdict: 'approve',
      obstacle: null,
      refinedIdea: revision,
      editorResponse: null,
      editorIdentity: null,
      revision: 1,
    });
    expect(stored.refinedIdeaIdentity).toEqual(expect.any(String));
    expect(await readFile(stored.report.path, 'utf8')).toBe(controlledReport);
    expect(stored).not.toHaveProperty('reportIdentity');
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
    const agent = scriptedRuntime([{ verdict: 'approve', obstacle: null }]);
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
    await writeChallenge(area, {
      cycle: 1,
      verdict: 'approve',
      obstacle: null,
      markdown: 'The first revision has a plausible way forward.',
      refinedIdea: first,
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
        obstacle: 'The revised idea promises more coverage than the evidence supports.',
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

  it('rejects a response that returns narrative instead of the minimal outcome', async () => {
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

    await expect(challenger()).rejects.toThrow(/does not match the response format/u);
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
        obstacle: null,
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

  it('rejects an approval that states a remaining obstacle', async () => {
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
        verdict: 'approve',
        obstacle: 'The idea may slow everyday work without saying how it stays fast.',
      },
    ]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(challenger()).rejects.toThrow(/stating a remaining obstacle/u);
    await expect(area.exists('artifacts/submissions/1/cycles/1/challenger.json')).resolves.toBe(
      false,
    );
  });
});
describe('decision publication', () => {
  const capturedSummary = 'Add a lint gate';

  /** Write an approval-ready cycle: framing, one revision and an approving Challenger result. */
  async function approvedCycle(area: RefinementArea) {
    await area.writeReported(
      1,
      framingArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'idea-editor',
        profile: 'nexus-editor',
        framing: framingFixture.framing,
        questions: framingFixture.questions,
        authorDecision: null,
      },
      '# Framing\n',
      'editor-framing-1',
    );
    await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      idea: 'Add a lint gate so reviews stay on behaviour.',
      projectFit: 'The project already enforces checks in CI.',
      feasibility: 'Adopt the smallest configured lint gate.',
      openQuestions: [],
      changeSummary: 'Framed the gate and the smallest configuration.',
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await writeChallenge(area, {
      cycle: 1,
      verdict: 'approve',
      obstacle: null,
      markdown: 'The idea is worth pursuing.',
      refinedIdea: path.join(area.cycleRoot(), refinedIdeaArtifact.pathFromArtifactsRoot),
      revision: 1,
    });
  }

  /** A controlled source: the issue, its conversation and the permitted transitions. */
  function source(status = 'Idea Refinement') {
    const comments: JiraComment[] = [];
    const transitions: string[] = [];
    let current = status;
    const scripted = scriptedJira({
      readIssue: () =>
        ok({
          id: '10518',
          key: 'NEX-1',
          fields: {
            summary: capturedSummary,
            description: { type: 'doc', content: [] },
            status: { id: '2', name: current },
          },
        }),
      readComments: () => ok([...comments]),
      readTransitions: () =>
        ok([
          { id: '21', name: 'Approve', to: { id: '3', name: 'Draft' } },
          { id: '22', name: 'Request feedback', to: { id: '4', name: 'Waiting for Feedback' } },
        ] satisfies JiraTransition[]),
      addComment: (_issueId, body) => {
        const comment = { id: `c${String(comments.length + 2)}`, body };
        comments.push(comment);
        return ok(comment);
      },
      transitionIssue: (_issueId, transitionId) => {
        transitions.push(transitionId);
        current = transitionId === '21' ? 'Draft' : 'Waiting for Feedback';
        return ok(undefined);
      },
    });
    return { jira: scripted.jira, calls: scripted.calls, comments, transitions };
  }

  /** The child's record action and the parent's publication over one refinement area. */
  function decisionActions(
    area: Awaited<ReturnType<typeof refinementArea>>,
    jira: ReturnType<typeof source>,
    selectionFile: string,
    expected?: readonly string[],
  ) {
    const record = createRecordIdeaDecision({
      selectionFile,
      submittedStatus: 'Idea',
      publish: (event) => area.events.push(event),
    });
    const publishDecision = createPublishDecision({
      selection: {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: capturedInput.issue,
        conversation: [],
        workspace: { root: path.dirname(area.root) },
        stage: 'idea',
      },
      refinementRoot: area.root,
      ...(expected === undefined ? {} : { expected }),
      statuses: { approved: 'Draft', waitingForFeedback: 'Waiting for Feedback' },
      jira: jira.jira,
      publish: (event) => area.events.push(event),
    });
    return { record, publishDecision };
  }

  /** The composed child-record and parent-publication one publication test drives. */
  function publication(
    area: Awaited<ReturnType<typeof refinementArea>>,
    jira: ReturnType<typeof source>,
    selectionFile: string,
    expected?: readonly string[],
  ) {
    const { record, publishDecision } = decisionActions(area, jira, selectionFile, expected);
    return async (input?: unknown) => {
      await record(input);
      return publishDecision();
    };
  }

  it('records and publishes an approval, then reuses the retained publication', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    const selectionFile = path.join(path.dirname(area.root), 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: capturedInput.issue,
        conversation: [],
        workspace: { root: path.dirname(area.root) },
        stage: 'idea',
      }),
    );
    const jira = source();
    const decide = publication(area, jira, selectionFile);

    await expect(decide({ decision: 'approved' })).resolves.toBe('approved');
    expect(jira.transitions).toEqual(['21']);
    expect(jira.comments).toHaveLength(1);
    const record = JSON.parse(
      await readFile(path.join(area.root, 'artifacts/submissions/1/decision.json'), 'utf8'),
    ) as IdeaDecisionRecord;
    expect(record.decision).toBe('approved');
    expect(record.source?.status).toBe('Draft');
    expect(commentText(record)).toContain('Approved refined idea');
    const handoff = JSON.parse(
      await readFile(path.join(area.root, ideaHandoffFile), 'utf8'),
    ) as IdeaHandoff;
    expect(handoff.refinedIdea).toBe(record.refinedIdea);

    // Interrupt between the decision and its downstream handoff: replay must finish the handoff.
    await rm(path.join(area.root, ideaHandoffFile));
    await expect(decide({ decision: 'approved' })).resolves.toBe('approved');
    expect(JSON.parse(await readFile(path.join(area.root, ideaHandoffFile), 'utf8'))).toEqual(
      handoff,
    );
    expect(jira.transitions).toEqual(['21']);
    expect(jira.comments).toHaveLength(1);
  });

  it.each(['approve', 'discuss'] as const)(
    'preserves a legacy %s assessment through reassessment, context and handoff replay',
    async (verdict) => {
      const area = await refinementArea();
      await approvedCycle(area);
      const revision = path.join(area.cycleRoot(), refinedIdeaArtifact.pathFromArtifactsRoot);
      const legacy = {
        verdict,
        assessment: 'Historical assessment with vendor-reported evidence, not local measurements.',
        obstacle: verdict === 'discuss' ? 'The benefit needs evidence.' : null,
        concerns: [
          {
            concern: 'Evidence comes from a vendor.',
            consequence: 'The benefit is uncertain.',
            resolution: 'Check comparable local results.',
          },
        ],
        suggestions: ['Keep the initial configuration small.'],
        refinedIdea: revision,
        editorResponse: null,
        revision: 1,
      };
      const original = `${JSON.stringify(legacy, null, 4)}\n\n`;
      const currentFile = path.join(area.cycleRoot(), challengerArtifact.pathFromArtifactsRoot);
      const historyFile = path.join(
        area.cycleRoot(),
        legacyChallengerArtifact.pathFromArtifactsRoot,
      );
      await writeFile(currentFile, original);
      // A retry can find the copy already saved before the current result was written.
      if (verdict === 'discuss') {
        await writeFile(historyFile, original);
      }
      const agent = scriptedRuntime([{ verdict: 'approve', obstacle: null }]);
      const challenger = createChallenger({
        workspace: { root: area.root },
        runner: runnerOf(agent.runtime),
        publish: (event) => area.events.push(event),
      });
      await expect(challenger()).resolves.toBe('approve');
      await expect(readFile(historyFile, 'utf8')).resolves.toBe(original);
      const stored = await area.read(1, challengerArtifact.pathFromArtifactsRoot);
      expect(challengerReportSchema.safeParse(stored).success).toBe(true);
      expect(stored).toMatchObject({
        verdict: 'approve',
        refinedIdea: revision,
        refinedIdeaIdentity: recordIdentity(JSON.parse(await readFile(revision, 'utf8'))),
        editorResponse: null,
        editorIdentity: null,
      });
      await expect(challenger()).resolves.toBe('approve');
      expect(agent.requests).toHaveLength(1);

      const researcherAgent = scriptedRuntime([{}]);
      await createResearcher({
        workspace: { root: area.root },
        runner: runnerOf(researcherAgent.runtime),
        publish: (event) => area.events.push(event),
      })({ phase: 'initial' });
      expect(researcherAgent.requests[0]?.context).toContain(
        `challenger, retained combined record: ${historyFile}`,
      );
      expect(
        await retainedHistoryText(area.root, area.plan, {
          workId: 'NEX-1',
          omitCurrentCycleOf: null,
        }),
      ).toContain(historyFile);

      const record = createRecordIdeaDecision({
        selectionFile: await selectionFileFor(area),
        submittedStatus: 'Idea',
        publish: (event) => area.events.push(event),
      });
      await expect(record({ decision: 'approved' })).resolves.toBe('recorded');
      const handoff = JSON.parse(
        await readFile(path.join(area.root, ideaHandoffFile), 'utf8'),
      ) as IdeaHandoff;
      expect(handoff.challengerResults).toEqual([historyFile, currentFile]);
      await rm(path.join(area.root, ideaHandoffFile));
      await expect(record({ decision: 'approved' })).resolves.toBe('recorded');
      expect(JSON.parse(await readFile(path.join(area.root, ideaHandoffFile), 'utf8'))).toEqual(
        handoff,
      );
      await expect(readFile(historyFile, 'utf8')).resolves.toBe(original);
      await expect(readFile(path.join(area.root, ideaRoundPlanFile), 'utf8')).resolves.toBe(
        JSON.stringify(area.plan),
      );
      await expect(readdir(path.dirname(area.cycleRoot()))).resolves.toEqual(['1']);
    },
  );

  it('preserves a human feedback pause while an approval is awaiting publication', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    const selectionFile = path.join(path.dirname(area.root), 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: capturedInput.issue,
        conversation: [],
        workspace: { root: path.dirname(area.root) },
        stage: 'idea',
      }),
    );
    const jira = source('Waiting for Feedback');
    await expect(
      publication(area, jira, selectionFile, ['Idea Refinement'])({ decision: 'approved' }),
    ).resolves.toBe('failed');
    expect(jira.transitions).toEqual([]);
    expect(jira.comments).toEqual([]);
  });

  it('preserves an unexpected human status change instead of overwriting it', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    const selectionFile = path.join(path.dirname(area.root), 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: capturedInput.issue,
        conversation: [],
        workspace: { root: path.dirname(area.root) },
        stage: 'idea',
      }),
    );
    // A human paused the item while the child was refining; the publication may only write from
    // the status its own selection left behind (or the target a repeat already applied).
    const jira = source('Blocked');
    const decide = publication(area, jira, selectionFile, [
      'Idea Refinement',
      'Draft',
      'Waiting for Feedback',
    ]);

    await expect(decide({ decision: 'approved' })).resolves.toBe('failed');
    expect(jira.transitions).toEqual([]);
    expect(jira.comments).toHaveLength(0);
  });

  it.each(['unsuitable', 'author-decision-needed', 'attempts-exhausted'] as const)(
    'publishes the %s return as Waiting for Feedback',
    async (decision) => {
      const area = await refinementArea();
      const selectionFile = path.join(path.dirname(area.root), 'selection.json');
      await writeFile(
        selectionFile,
        JSON.stringify({
          taskKey: 'NEX-1',
          source: { kind: 'jira', issueId: '10518' },
          task: capturedInput.issue,
          conversation: [],
          workspace: { root: path.dirname(area.root) },
          stage: 'idea',
        }),
      );
      if (decision === 'unsuitable') {
        await area.writeReported(
          1,
          editorResponseArtifact.pathFromArtifactsRoot,
          {
            taskKey: 'NEX-1',
            role: 'idea-editor',
            profile: 'nexus-editor',
            disposition: 'unsuitable',
            reason: 'The idea does not serve a plausible user outcome.',
            help: null,
          },
          '# Unsuitable\n',
          'editor-turn-1',
        );
      }
      if (decision === 'author-decision-needed') {
        await area.writeReported(
          1,
          framingArtifact.pathFromArtifactsRoot,
          {
            taskKey: 'NEX-1',
            role: 'idea-editor',
            profile: 'nexus-editor',
            framing: framingFixture.framing,
            questions: framingFixture.questions,
            authorDecision: { question: 'Which user should this serve?' },
          },
          '# Framing\n',
          'editor-framing-1',
        );
      }
      if (decision === 'attempts-exhausted') {
        await approvedCycle(area);
        await writeChallenge(area, {
          cycle: 1,
          verdict: 'discuss',
          obstacle: 'Nothing yet shows the gate is worth the change.',
          markdown: 'The value concern is still open.',
          refinedIdea: path.join(area.cycleRoot(), refinedIdeaArtifact.pathFromArtifactsRoot),
          revision: 1,
          invocationId: 'challenger-exhausted',
        });
      }
      const jira = source();
      const decide = publication(area, jira, selectionFile);
      await expect(decide({ decision })).resolves.toBe('waiting-for-feedback');
      expect(jira.transitions).toEqual(['22']);
      expect(jira.comments).toHaveLength(1);
      const record = JSON.parse(
        await readFile(path.join(area.root, 'artifacts/submissions/1/decision.json'), 'utf8'),
      ) as IdeaDecisionRecord;
      expect(record.decision).toBe(decision);
      expect(record.source?.status).toBe('Waiting for Feedback');
    },
  );

  it('rejects an approval without the approving Challenger result', async () => {
    const area = await refinementArea();
    const selectionFile = path.join(path.dirname(area.root), 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: capturedInput.issue,
        conversation: [],
        workspace: { root: path.dirname(area.root) },
        stage: 'idea',
      }),
    );
    const jira = source();
    await expect(publication(area, jira, selectionFile)({ decision: 'approved' })).rejects.toThrow(
      /Approval needs the refined idea revision/u,
    );
  });

  it('reports a missing publication transition as a failed outcome', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    const selectionFile = path.join(path.dirname(area.root), 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: capturedInput.issue,
        conversation: [],
        workspace: { root: path.dirname(area.root) },
        stage: 'idea',
      }),
    );
    const jira = scriptedJira({
      readIssue: () =>
        ok({
          id: '10518',
          key: 'NEX-1',
          fields: {
            summary: capturedSummary,
            description: { type: 'doc', content: [] },
            status: { id: '2', name: 'Idea Refinement' },
          },
        }),
      readComments: () => ok([]),
      readTransitions: () => ok([]),
    });
    const decide = publication(
      area,
      { ...jira, calls: jira.calls, comments: [], transitions: [] },
      selectionFile,
    );
    await expect(decide({ decision: 'approved' })).resolves.toBe('failed');
  });

  /** The child's selection file beside one refinement area. */
  async function selectionFileFor(area: RefinementArea): Promise<string> {
    const selectionFile = path.join(path.dirname(area.root), 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: capturedInput.issue,
        conversation: [],
        workspace: { root: path.dirname(area.root) },
        stage: 'idea',
      }),
    );
    return selectionFile;
  }

  /**
   * The approved decision's evidence paths, read from the records it names: the Challenger
   * result's Markdown and the editor outcome's Markdown.
   */
  async function approvalBindings(area: RefinementArea): Promise<{
    readonly decision: IdeaDecisionRecord;
    readonly challenger: string;
    readonly editor: string;
  }> {
    const decision = JSON.parse(
      await readFile(path.join(area.root, 'artifacts/submissions/1/decision.json'), 'utf8'),
    ) as IdeaDecisionRecord;
    if (decision.challenger === null) {
      throw new Error('The fixture approval needs a Challenger result.');
    }
    const challenger = JSON.parse(await readFile(decision.challenger, 'utf8')) as {
      readonly report: { readonly path: string };
    };
    const editor = JSON.parse(await readFile(decision.editor, 'utf8')) as {
      readonly report: { readonly path: string };
    };
    return { decision, challenger: challenger.report.path, editor: editor.report.path };
  }

  it.each([
    ['the Challenger result', 'challenger', 'challenger', 'challenge'],
    ['the editor framing', 'editor', 'idea-editor', 'idea-framing'],
  ] as const)(
    'rejects reusing an approval whose %s has no bound Markdown',
    async (_label, target, role, reportKind) => {
      const area = await refinementArea();
      await approvedCycle(area);
      const selectionFile = await selectionFileFor(area);
      const jira = source();
      const { record, publishDecision } = decisionActions(area, jira, selectionFile);
      await expect(record({ decision: 'approved' })).resolves.toBe('recorded');
      const bindings = await approvalBindings(area);

      await rm(bindings[target]);
      await expect(record({ decision: 'approved' })).rejects.toThrow(/does not exist/u);
      const scope = {
        project: projectOfWorkspace(path.dirname(area.root)),
        workId: 'NEX-1',
        area: area.root,
        role,
        reportKind,
      };
      const feedback = await outstandingReportFeedback({ areaRoot: area.root, scope });
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.record).toMatchObject({
        operation: role === 'challenger' ? 'Challenger' : 'FrameIdea',
        invocationId: role === 'challenger' ? 'challenger-1' : 'editor-framing-1',
        profile: role === 'challenger' ? 'nexus-challenger' : 'nexus-editor',
        source: {
          path: target === 'challenger' ? bindings.decision.challenger : bindings.decision.editor,
        },
        assignedReport: { path: bindings[target] },
      });
      // The recorded approval and its handoff stay untouched by the failed reuse.
      const retained = await approvalBindings(area);
      expect(retained.decision).toEqual(bindings.decision);
      await expect(readFile(path.join(area.root, ideaHandoffFile), 'utf8')).resolves.toContain(
        bindings.decision.refinedIdea ?? '',
      );

      // Parent publication revalidates the same binding before it writes any source state.
      await expect(publishDecision()).rejects.toThrow(/does not exist/u);
      expect(jira.transitions).toEqual([]);
      expect(jira.comments).toEqual([]);
    },
  );

  it('reuses an approval after its bound Markdown was reworded readably', async () => {
    const area = await refinementArea();
    await approvedCycle(area);
    const selectionFile = await selectionFileFor(area);
    const jira = source();
    const { record } = decisionActions(area, jira, selectionFile);
    await expect(record({ decision: 'approved' })).resolves.toBe('recorded');
    const bindings = await approvalBindings(area);

    // Readable replacement wording is not a Markdown-byte gate: the saved approval is reused.
    await writeFile(bindings.editor, '# Reworded readable framing\n', 'utf8');
    await expect(record({ decision: 'approved' })).resolves.toBe('recorded');
    const scope = {
      project: projectOfWorkspace(path.dirname(area.root)),
      workId: 'NEX-1',
      area: area.root,
      role: 'idea-editor',
      reportKind: 'idea-framing',
    };
    await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toEqual([]);
  });

  /**
   * Record an approval in the current cycle with a turn and usable cycle-1 framing.
   * Return the turn's and framing's bound Markdown paths.
   */
  async function recordedTurnApproval(area: RefinementArea): Promise<{
    readonly record: (input?: unknown) => Promise<string>;
    readonly publishDecision: () => Promise<string>;
    readonly jira: ReturnType<typeof source>;
    readonly turnReport: string;
    readonly framingReport: string;
  }> {
    await area.writeReported(
      1,
      framingArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'idea-editor',
        profile: 'nexus-editor',
        framing: framingFixture.framing,
        questions: framingFixture.questions,
        authorDecision: null,
      },
      '# Framing\n',
      'editor-framing-1',
    );
    await area.write(area.plan.cycle, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      revision: 1,
      submission: 1,
      cycle: area.plan.cycle,
    });
    const turnFile = await area.writeReported(
      area.plan.cycle,
      editorResponseArtifact.pathFromArtifactsRoot,
      {
        taskKey: 'NEX-1',
        role: 'idea-editor',
        profile: 'nexus-editor',
        disposition: 'revised',
        reason: null,
        help: null,
      },
      '# The editor turn that wrote revision 1\n',
      'editor-turn-1',
    );
    await writeChallenge(area, {
      cycle: area.plan.cycle,
      verdict: 'approve',
      obstacle: null,
      markdown: 'Revision 1 is worth pursuing.',
      refinedIdea: path.join(area.cycleRoot(), refinedIdeaArtifact.pathFromArtifactsRoot),
      revision: 1,
      editorResponse: turnFile,
      editorIdentity: recordIdentity(JSON.parse(await readFile(turnFile, 'utf8')) as unknown),
    });
    const selectionFile = await selectionFileFor(area);
    const jira = source();
    const { record, publishDecision } = decisionActions(area, jira, selectionFile);
    await expect(record({ decision: 'approved' })).resolves.toBe('recorded');
    const bindings = await approvalBindings(area);
    expect(bindings.decision.editor).toBe(turnFile);
    const framing = JSON.parse(
      await readFile(path.join(area.cycleRoot(1), framingArtifact.pathFromArtifactsRoot), 'utf8'),
    ) as { readonly report: { readonly path: string } };
    return {
      record,
      publishDecision,
      jira,
      turnReport: bindings.editor,
      framingReport: framing.report.path,
    };
  }

  it.each([
    ['the editor turn', 'turn', 'idea-editor-turn', 'EditorTurn', 'editor-turn-1'],
    ['the fallback framing', 'framing', 'idea-framing', 'FrameIdea', 'editor-framing-1'],
  ] as const)(
    'revalidates %s an approval names before reusing or publishing it',
    async (_label, target, reportKind, operation, invocationId) => {
      const area = await refinementArea();
      const approval = await recordedTurnApproval(area);
      await rm(target === 'turn' ? approval.turnReport : approval.framingReport);

      await expect(approval.record({ decision: 'approved' })).rejects.toThrow(/does not exist/u);
      await expect(approval.publishDecision()).rejects.toThrow(/does not exist/u);
      expect(approval.jira.transitions).toEqual([]);
      expect(approval.jira.comments).toEqual([]);
      const scope = {
        project: projectOfWorkspace(path.dirname(area.root)),
        workId: 'NEX-1',
        area: area.root,
        role: 'idea-editor',
        reportKind,
      };
      const feedback = await outstandingReportFeedback({ areaRoot: area.root, scope });
      expect(feedback[0]?.record).toMatchObject({ operation, invocationId });
    },
  );

  it('rejects later-cycle approval replay and publication with missing cycle-1 framing Markdown', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const approval = await recordedTurnApproval(area);
    const decisionFile = path.join(area.root, 'artifacts/submissions/1/decision.json');
    const decisionBytes = await readFile(decisionFile, 'utf8');
    await rm(path.join(area.root, ideaHandoffFile));
    await rm(approval.framingReport);

    await expect(approval.record({ decision: 'approved' })).rejects.toThrow(/does not/u);
    await expect(approval.publishDecision()).rejects.toThrow(/does not/u);
    expect(approval.jira.transitions).toEqual([]);
    expect(approval.jira.comments).toEqual([]);
    await expect(readFile(decisionFile, 'utf8')).resolves.toBe(decisionBytes);
    expect(await area.exists(ideaHandoffFile)).toBe(false);
    const feedback = await readReportFeedback(area.root);
    expect(feedback[0]?.record).toMatchObject({
      scope: { role: 'idea-editor', reportKind: 'idea-framing' },
      invocationId: 'editor-framing-1',
      source: { path: path.join(area.cycleRoot(1), framingArtifact.pathFromArtifactsRoot) },
    });
  });

  it('replays and publishes a later-cycle approval after its framing was reworded readably', async () => {
    const area = await refinementArea({ cycle: 2, route: 'next' });
    const approval = await recordedTurnApproval(area);
    await rm(path.join(area.root, ideaHandoffFile));
    // Readable replacement wording is not a Markdown-byte gate: the retained cycle-1 framing
    // stays usable for the later-cycle approval's replay and publication.
    await writeFile(approval.framingReport, '# Reworded framing\n');

    await expect(approval.record({ decision: 'approved' })).resolves.toBe('recorded');
    await expect(approval.publishDecision()).resolves.toBe('approved');
    expect(approval.jira.transitions).toEqual(['21']);
    await expect(readReportFeedback(area.root)).resolves.toEqual([]);
  });

  it.each(['replay', 'publication'] as const)(
    'retains malformed approved revision evidence during %s',
    async (consumer) => {
      const area = await refinementArea({ cycle: 2, route: 'next' });
      const approval = await recordedTurnApproval(area);
      const file = path.join(area.cycleRoot(), refinedIdeaArtifact.pathFromArtifactsRoot);
      const rejected = '{ malformed revision';
      await writeFile(file, rejected);
      const consume =
        consumer === 'replay'
          ? () => approval.record({ decision: 'approved' })
          : approval.publishDecision;

      await expect(consume()).rejects.toThrow(/is not valid JSON/u);
      const feedback = await readReportFeedback(area.root);
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.record).toMatchObject({
        scope: { role: 'idea-editor', reportKind: 'idea-editor-turn' },
        operation: 'EditorTurn',
        source: { path: file },
        output: rejected,
        reason: expect.stringContaining('is not valid JSON'),
      });
      expect(approval.jira.transitions).toEqual([]);
      expect(approval.jira.comments).toEqual([]);
    },
  );

  const handoffProducers = [
    [researchArtifact, 'researcher', 'research', 'Researcher'],
    [researchFollowUpArtifact, 'researcher', 'research', 'Researcher'],
    [projectGuideArtifact, 'project-guide', 'project-guidance', 'ProjectGuide'],
    [projectGuideFollowUpArtifact, 'project-guide', 'project-guidance', 'ProjectGuide'],
    [editorResponseArtifact, 'idea-editor', 'idea-editor-turn', 'EditorTurn'],
    [challengerArtifact, 'challenger', 'challenge', 'Challenger'],
  ] as const;

  it.each(handoffProducers)(
    'retains malformed %s history under its producer during handoff reconstruction',
    async (artifact, role, reportKind, operation) => {
      const area = await refinementArea({ cycle: 2, route: 'next' });
      const approval = await recordedTurnApproval(area);
      // Cycle-1 history is not the cycle-2 approval evidence. Handoff assembly is the reader
      // responsible for detecting this damage and retaining it for the historical producer.
      const file = await area.writeReported(
        1,
        artifact.pathFromArtifactsRoot,
        {
          taskKey: 'NEX-1',
          role,
          profile: 'historical-profile',
          ...(role === 'idea-editor'
            ? { disposition: 'answered', reason: null, help: null }
            : role === 'challenger'
              ? {
                  verdict: 'discuss',
                  obstacle: 'A remaining concern',
                  revision: 1,
                  refinedIdea: path.join(
                    area.cycleRoot(1),
                    refinedIdeaArtifact.pathFromArtifactsRoot,
                  ),
                  refinedIdeaIdentity: 'historical-identity',
                  editorResponse: null,
                  editorIdentity: null,
                }
              : { question: null }),
        },
        '# Historical contribution\n',
        'historical-invocation',
      );
      const intact = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      const damaged = { ...intact };
      delete damaged.taskKey;
      const rejected = JSON.stringify(damaged);
      await writeFile(file, rejected);
      await rm(path.join(area.root, ideaHandoffFile));

      await expect(approval.record({ decision: 'approved' })).rejects.toThrow(
        /declared content type/u,
      );
      const feedback = await readReportFeedback(area.root);
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.record).toMatchObject({
        scope: { role, reportKind },
        operation,
        invocationId: 'historical-invocation',
        profile: 'historical-profile',
        source: { path: file },
        output: rejected,
        assignedReport: damaged.report,
      });
      const retainedReport = feedback[0]?.record;
      expect(retainedReport?.kind).toBe('rejection');
      if (retainedReport?.kind === 'rejection') {
        expect(retainedReport.report).not.toBeNull();
        await expect(readFile(retainedReport.report!.path, 'utf8')).resolves.toBe(
          '# Historical contribution\n',
        );
      }
      expect(await area.exists(ideaHandoffFile)).toBe(false);
      // Repairing the artifact permits handoff reconstruction, but cannot retire feedback.
      await writeFile(file, JSON.stringify(intact));
      await expect(approval.record({ decision: 'approved' })).resolves.toBe('recorded');
      const handoff = JSON.parse(
        await readFile(path.join(area.root, ideaHandoffFile), 'utf8'),
      ) as IdeaHandoff;
      expect([
        ...handoff.contributions,
        ...handoff.editorResponses,
        ...handoff.challengerResults,
      ]).toContain(file);
      await expect(readReportFeedback(area.root)).resolves.toHaveLength(1);
    },
  );

  it.each([
    [researchArtifact, 'researcher', 'research'],
    [projectGuideArtifact, 'project-guide', 'project-guidance'],
  ] as const)(
    'retains an unusable %s report during fresh handoff assembly',
    async (_artifact, role, reportKind) => {
      const area = await refinementArea();
      await approvedCycle(area);
      const file = role === 'researcher' ? await writeResearch(area) : await writeGuidance(area);
      const contribution = JSON.parse(await readFile(file, 'utf8')) as { report: { path: string } };
      // The contribution's bound report is no longer readable: fresh handoff assembly retains it
      // under the producing role instead of dropping the contribution silently.
      await rm(contribution.report.path);
      const jira = source();
      const actions = decisionActions(area, jira, await selectionFileFor(area));

      await expect(actions.record({ decision: 'approved' })).rejects.toThrow(/does not exist/u);
      expect(await area.exists(ideaHandoffFile)).toBe(false);
      const feedback = await readReportFeedback(area.root);
      expect(feedback[0]?.record).toMatchObject({
        scope: { role, reportKind },
        source: { path: file },
        assignedReport: contribution.report,
      });
    },
  );
});

describe('retained idea reports', () => {
  it('reads a parent return through the returning role\u2019s saved binding', async () => {
    const area = await refinementArea();
    const report = path.join(
      path.dirname(area.root),
      'ux',
      'artifacts',
      '1',
      'reports',
      'inv-1',
      'evaluator.md',
    );
    await mkdir(path.dirname(report), { recursive: true });
    const markdown = '# Assessment\n\nThe controlled narrative.\n';
    await writeFile(report, markdown);
    const outcome = { path: path.join(path.dirname(area.root), 'ux/artifacts/1/evaluation.json') };
    const output = JSON.stringify({ verdict: 'return-upstream', invocationId: 'inv-1' });
    await writeFile(outcome.path, output);
    const boundInput = {
      ...capturedInput,
      parentInput: {
        question: null,
        returnFinding: {
          from: 'ux' as const,
          role: 'evaluator' as const,
          report: {
            report: { path: report },
            invocationId: 'inv-1',
            outcome,
            profile: 'nexus-sol',
          },
          correction: 'Correct the acceptance example.',
        },
      },
    };

    // The readable report reaches the idea role through its producer-owned binding.
    const context = await capturedIdeaText(area.root, area.plan, boundInput);
    expect(context).toContain('Correct the acceptance example.');
    expect(context).toContain('The complete returning report:');
    expect(context).toContain('The controlled narrative.');

    // Readable replacement wording is embedded as the current returning evidence: no
    // Markdown-byte gate rejects it.
    await writeFile(report, '# Replacement\n\nSubstituted evidence.\n');
    await expect(capturedIdeaText(area.root, area.plan, boundInput)).resolves.toContain(
      'Substituted evidence.',
    );
    await expect(readReportFeedback(path.join(path.dirname(area.root), 'ux'))).resolves.toEqual([]);

    // A report deleted after the binding was saved is unusable evidence: it is retained as the
    // returning role's rejection instead of being silently dropped.
    await rm(report);
    await expect(capturedIdeaText(area.root, area.plan, boundInput)).rejects.toThrow(
      /does not exist/,
    );
    const feedback = await readReportFeedback(path.join(path.dirname(area.root), 'ux'));
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.record).toMatchObject({
      kind: 'rejection',
      scope: { role: 'ux-evaluator', reportKind: 'stage-evaluation' },
      assignedReport: { path: report },
      source: outcome,
      output,
      invocationId: 'inv-1',
      profile: 'nexus-sol',
    });
  });

  /** The report responsibility one idea role's saved report belongs to. */
  function scopeOf(
    area: { readonly root: string },
    role: 'idea-editor' | 'researcher' | 'project-guide' | 'challenger',
    reportKind: string,
  ) {
    return {
      project: projectOfWorkspace(path.dirname(area.root)),
      workId: 'NEX-1',
      area: area.root,
      role,
      reportKind,
    };
  }

  it.each(['researcher', 'project-guide', 'challenger'] as const)(
    'retains unreadable framing from the %s context for the framing producer',
    async (role) => {
      const area = await refinementArea();
      await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
        ...revisedTurn(1).refinedIdea,
        revision: 1,
        submission: 1,
        cycle: 1,
      });
      const file = path.join(area.cycleRoot(), framingArtifact.pathFromArtifactsRoot);
      await mkdir(file);
      const unused = scriptedRuntime([]);
      const settings = {
        workspace: { root: area.root },
        runner: runnerOf(unused.runtime),
        publish: (event: EngineEvent) => area.events.push(event),
      };
      const action = {
        researcher: createResearcher,
        'project-guide': createProjectGuide,
        challenger: createChallenger,
      }[role](settings);
      await expect(action({ phase: 'initial' })).rejects.toThrow('could not be read');
      expect(unused.requests).toHaveLength(0);
      const scope = scopeOf(area, 'idea-editor', 'idea-framing');
      const feedback = await outstandingReportFeedback({ areaRoot: area.root, scope });
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.record).toMatchObject({
        scope,
        operation: 'FrameIdea',
        profile: profiles['idea-editor'],
        invocationId: null,
        source: { path: file },
        output: null,
        reason: expect.stringContaining(`Artifact at "${file}" could not be read`),
      });
      await expect(
        outstandingReportFeedback({
          areaRoot: area.root,
          scope: scopeOf(area, 'idea-editor', 'idea-editor-turn'),
        }),
      ).resolves.toEqual([]);

      await rm(file, { recursive: true });
      await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toHaveLength(
        1,
      );
      const resumed = scriptedRuntime([framingFixture]);
      const editor = createIdeaEditor({
        ...settings,
        runner: runnerOf(resumed.runtime),
      });
      await expect(editor({ task: 'frame' })).resolves.toBe('framed');
      const context = resumed.requests[0]?.context ?? '';
      expect(context).toContain('Outstanding report rejection');
      expect(context).toContain(`Artifact at "${file}" could not be read`);
      expect(context).toContain('unavailable');
      await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toEqual([]);
      expect(
        (await readReportFeedback(area.root)).filter((entry) => entry.record.kind === 'rejection'),
      ).toHaveLength(1);
    },
  );

  it('retains unreadable research encountered in editor history for the next researcher', async () => {
    const area = await refinementArea();
    const file = path.join(area.cycleRoot(), researchArtifact.pathFromArtifactsRoot);
    await mkdir(file, { recursive: true });
    const unused = scriptedRuntime([]);
    const settings = {
      workspace: { root: area.root },
      runner: runnerOf(unused.runtime),
      publish: (event: EngineEvent) => area.events.push(event),
    };
    const editor = createIdeaEditor(settings);
    await expect(editor({ task: 'edit' })).rejects.toThrow('could not be read');
    expect(unused.requests).toHaveLength(0);
    const scope = scopeOf(area, 'researcher', 'research');
    const feedback = await outstandingReportFeedback({ areaRoot: area.root, scope });
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.record).toMatchObject({
      scope,
      operation: 'Researcher',
      profile: profiles.researcher,
      source: { path: file },
      output: null,
      reason: expect.stringContaining(`Artifact at "${file}" could not be read`),
    });
    await rm(file, { recursive: true });
    await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toHaveLength(
      1,
    );
    const resumed = scriptedRuntime([researchResponse], researchReport);
    const researcher = createResearcher({ ...settings, runner: runnerOf(resumed.runtime) });
    await expect(researcher({ phase: 'initial' })).resolves.toBe('contributed');
    const context = resumed.requests[0]?.context ?? '';
    expect(context).toContain('Outstanding report rejection');
    expect(context).toContain(`Artifact at "${file}" could not be read`);
    expect(context).toContain('unavailable');
    await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toEqual([]);
  });

  it.each([
    ['editor-framing.json', 'idea-editor', 'idea-framing'],
    ['refined-idea.json', 'idea-editor', 'idea-editor-turn'],
    ['editor-response.json', 'idea-editor', 'idea-editor-turn'],
    ['editor-help-request.json', 'idea-editor', 'idea-editor-turn'],
    ['researcher.json', 'researcher', 'research'],
    ['researcher-follow-up.json', 'researcher', 'research'],
    ['project-guide.json', 'project-guide', 'project-guidance'],
    ['project-guide-follow-up.json', 'project-guide', 'project-guidance'],
    ['challenger.json', 'challenger', 'challenge'],
    ['challenger-legacy.json', 'challenger', 'challenge'],
    ['brief.json', 'idea-editor', 'idea-editor-turn'],
    ['purpose.json', 'project-guide', 'legacy-purpose'],
    ['research.json', 'researcher', 'legacy-research'],
    ['council/purpose.json', 'challenger', 'legacy-council-purpose'],
    ['council/evidence.json', 'challenger', 'legacy-council-evidence'],
    ['council/simplicity.json', 'challenger', 'legacy-council-simplicity'],
  ] as const)(
    'attributes unreadable earlier history at %s to its producer and compatible contract',
    async (relative, role, reportKind) => {
      const area = await refinementArea({ cycle: 2 });
      const file = path.join(area.cycleRoot(1), relative);
      await mkdir(file, { recursive: true });
      await expect(
        retainedHistoryText(area.root, area.plan, {
          workId: capturedInput.taskKey,
          // Omitting a parallel role's current contribution must not omit its older history.
          omitCurrentCycleOf: role,
        }),
      ).rejects.toThrow('could not be read');
      const feedback = await readReportFeedback(area.root);
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.record).toMatchObject({
        scope: scopeOf(area, role, reportKind),
        profile: profiles[role],
        invocationId: null,
        source: { path: file },
        output: null,
        context: expect.stringContaining('submission 1 cycle 1'),
        reason: expect.stringContaining(`Artifact at "${file}" could not be read`),
      });
      await expect(
        outstandingReportFeedback({
          areaRoot: area.root,
          scope: { ...scopeOf(area, role, reportKind), workId: 'NEX-2' },
        }),
      ).resolves.toEqual([]);
    },
  );

  it('keeps absent reports and omitted concurrent contributions out of history and feedback', async () => {
    const area = await refinementArea();
    const options = { workId: capturedInput.taskKey, omitCurrentCycleOf: 'researcher' as const };
    const initial = await retainedHistoryText(area.root, area.plan, options);
    expect(initial).toContain('captured idea input');
    expect(initial).not.toContain('cycle 1');
    const file = path.join(area.cycleRoot(), researchArtifact.pathFromArtifactsRoot);
    await mkdir(file, { recursive: true });
    await expect(retainedHistoryText(area.root, area.plan, options)).resolves.toBe(initial);
    await expect(readReportFeedback(area.root)).resolves.toEqual([]);
  });

  it('does not supply legacy research rejection to the current research contract', async () => {
    const area = await refinementArea();
    const file = path.join(area.cycleRoot(), 'research.json');
    await mkdir(file, { recursive: true });
    const options = { workId: capturedInput.taskKey, omitCurrentCycleOf: null };
    await expect(retainedHistoryText(area.root, area.plan, options)).rejects.toThrow(
      'could not be read',
    );
    await rm(file, { recursive: true });
    // A historical repair leaves its rejection outstanding without authorizing a current role
    // to correct a response contract it does not implement.
    await writeFile(file, '{"legacy":"repaired"}');
    const agent = scriptedRuntime([researchResponse], researchReport);
    const researcher = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });
    await expect(researcher({ phase: 'initial' })).resolves.toBe('contributed');
    expect(agent.requests[0]?.context).not.toContain('Outstanding report rejection');
    await expect(
      outstandingReportFeedback({
        areaRoot: area.root,
        scope: scopeOf(area, 'researcher', 'legacy-research'),
      }),
    ).resolves.toHaveLength(1);
    expect(
      (await readReportFeedback(area.root)).filter((entry) => entry.record.kind === 'correction'),
    ).toEqual([]);
  });

  it('preserves an unusable retained research contribution for the next researcher', async () => {
    const area = await refinementArea();
    const file = path.join(area.cycleRoot(), researchArtifact.pathFromArtifactsRoot);
    const malformed = '{"contribution":"The gate helps.",';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, malformed, 'utf8');
    const scope = scopeOf(area, 'researcher', 'research');
    const unused = scriptedRuntime([researchResponse], researchReport);
    const researcher = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(unused.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(researcher({ phase: 'initial' })).rejects.toThrow(/is not valid JSON/);
    expect(unused.requests).toHaveLength(0);
    const retained = (await readReportFeedback(area.root)).find(
      (entry) => entry.record.kind === 'rejection',
    );
    expect(retained?.record).toMatchObject({
      scope,
      operation: 'Researcher',
      source: { path: file },
      output: malformed,
      reason: expect.stringContaining('is not valid JSON'),
    });

    // Replacing the unusable record does not resolve the feedback by itself; the next permitted
    // researcher receives it and its validated saved contribution records the correction.
    await rm(file);
    await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toHaveLength(
      1,
    );
    const recovery = scriptedRuntime([researchResponse], researchReport);
    const next = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(recovery.runtime),
      publish: (event) => area.events.push(event),
    });
    await expect(next({ phase: 'initial' })).resolves.toBe('contributed');
    const context = recovery.requests[0]?.context ?? '';
    expect(context).toContain('Outstanding report rejection');
    expect(context).toContain('is not valid JSON');
    expect(context).toContain(malformed);
    await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toEqual([]);
  });

  it('keeps a damaged outcome’s own invocation and profile attribution in retained feedback', async () => {
    const area = await refinementArea();
    const file = path.join(area.cycleRoot(), researchArtifact.pathFromArtifactsRoot);
    await mkdir(path.dirname(file), { recursive: true });
    // The record is valid JSON but its report binding is incomplete; its observed attribution
    // stays readable even though the outcome no longer parses.
    const damaged = {
      taskKey: 'NEX-1',
      role: 'researcher',
      profile: 'nexus-research-history',
      question: 'Which earlier evidence mattered?',
      invocationId: 'researcher-history-1',
    };
    await writeFile(file, JSON.stringify(damaged), 'utf8');
    const settings = {
      workspace: { root: area.root },
      runner: runnerOf(scriptedRuntime([]).runtime),
      publish: (event: EngineEvent) => area.events.push(event),
    };
    const researcher = createResearcher(settings);

    await expect(researcher({ phase: 'initial' })).rejects.toThrow(/declared content type/u);
    const scope = scopeOf(area, 'researcher', 'research');
    const retained = (await outstandingReportFeedback({ areaRoot: area.root, scope }))[0];
    expect(retained?.record).toMatchObject({
      scope,
      operation: 'Researcher',
      invocationId: 'researcher-history-1',
      profile: 'nexus-research-history',
      source: { path: file },
    });

    // A continuation under a different configured profile still receives and retires the
    // rejection under its original attribution.
    await rm(file);
    area.plan.profiles.researcher = 'nexus-research-next';
    await writeFile(path.join(area.root, ideaRoundPlanFile), JSON.stringify(area.plan));
    const recovery = scriptedRuntime([researchResponse], researchReport);
    const next = createResearcher({ ...settings, runner: runnerOf(recovery.runtime) });
    await expect(next({ phase: 'initial' })).resolves.toBe('contributed');
    const context = recovery.requests[0]?.context ?? '';
    expect(context).toContain('researcher-history-1');
    expect(context).toContain('nexus-research-history');
    await expect(outstandingReportFeedback({ areaRoot: area.root, scope })).resolves.toEqual([]);
  });

  it('routes unusable editor and contribution reports to their own producers', async () => {
    const area = await refinementArea();
    await area.write(1, refinedIdeaArtifact.pathFromArtifactsRoot, {
      ...revisedTurn(1).refinedIdea,
      revision: 1,
      submission: 1,
      cycle: 1,
    });
    await writeResearch(area);
    const guideFile = path.join(area.cycleRoot(), projectGuideArtifact.pathFromArtifactsRoot);
    const malformedGuidance = '{"contribution":"It fits the project.",';
    await mkdir(path.dirname(guideFile), { recursive: true });
    await writeFile(guideFile, malformedGuidance, 'utf8');

    // The editor reads the Project guide's contribution; that responsibility owns its rejection.
    const unusedEditor = scriptedRuntime([revisedTurn(1)]);
    const editor = createIdeaEditor({
      workspace: { root: area.root },
      runner: runnerOf(unusedEditor.runtime),
      publish: (event) => area.events.push(event),
    });
    await expect(editor({ task: 'edit' })).rejects.toThrow(/is not valid JSON/);
    expect(unusedEditor.requests).toHaveLength(0);
    const guideScope = scopeOf(area, 'project-guide', 'project-guidance');
    const guideRejection = (
      await outstandingReportFeedback({ areaRoot: area.root, scope: guideScope })
    )[0];
    expect(guideRejection?.record).toMatchObject({
      scope: guideScope,
      operation: 'ProjectGuide',
      source: { path: guideFile },
      output: malformedGuidance,
      reason: expect.stringContaining('is not valid JSON'),
    });

    // The Challenger then reads the editor's saved response; the editor's responsibility owns
    // that rejection, independently attributable from the Project guide's.
    const turnFile = path.join(area.cycleRoot(), editorResponseArtifact.pathFromArtifactsRoot);
    const malformedTurn = '{"disposition":"answered",';
    await writeFile(turnFile, malformedTurn, 'utf8');
    const unusedChallenger = scriptedRuntime([{ verdict: 'approve', obstacle: null }]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(unusedChallenger.runtime),
      publish: (event) => area.events.push(event),
    });
    await expect(challenger()).rejects.toThrow(/is not valid JSON/);
    expect(unusedChallenger.requests).toHaveLength(0);
    const editorScope = scopeOf(area, 'idea-editor', 'idea-editor-turn');
    const turnRejection = (
      await outstandingReportFeedback({ areaRoot: area.root, scope: editorScope })
    )[0];
    expect(turnRejection?.record).toMatchObject({
      scope: editorScope,
      source: { path: turnFile },
      output: malformedTurn,
      reason: expect.stringContaining('is not valid JSON'),
    });

    // The Project guide receives its own rejection and its validated saved contribution records
    // the correction; the editor's rejection stays outstanding under the editor's responsibility.
    // The malformed editor turn is removed with the guide's own malformed contribution: unreadable
    // retained records block a later consumer until their producer replaces them.
    await rm(guideFile);
    await rm(turnFile);
    const guideAgent = scriptedRuntime([guidanceResponse], guidanceReport);
    const guide = createProjectGuide({
      workspace: { root: area.root },
      runner: runnerOf(guideAgent.runtime),
      publish: (event) => area.events.push(event),
    });
    await expect(guide({ phase: 'initial' })).resolves.toBe('contributed');
    const guideContext = guideAgent.requests[0]?.context ?? '';
    expect(guideContext).toContain('Outstanding report rejection');
    expect(guideContext).toContain(malformedGuidance);
    expect(guideContext).not.toContain(malformedTurn);
    await expect(
      outstandingReportFeedback({ areaRoot: area.root, scope: guideScope }),
    ).resolves.toEqual([]);
    await expect(
      outstandingReportFeedback({ areaRoot: area.root, scope: editorScope }),
    ).resolves.toHaveLength(1);
  });

  it('preserves an unusable retained refined idea revision under the editor responsibility', async () => {
    const area = await refinementArea();
    const file = path.join(area.cycleRoot(), refinedIdeaArtifact.pathFromArtifactsRoot);
    const malformed = '{"idea":"A lint gate would keep reviews on behaviour.",';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, malformed, 'utf8');
    const scope = scopeOf(area, 'idea-editor', 'idea-editor-turn');
    const unused = scriptedRuntime([{ verdict: 'approve', obstacle: null }]);
    const challenger = createChallenger({
      workspace: { root: area.root },
      runner: runnerOf(unused.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(challenger()).rejects.toThrow(/is not valid JSON/);
    expect(unused.requests).toHaveLength(0);
    const retained = (await outstandingReportFeedback({ areaRoot: area.root, scope }))[0];
    expect(retained?.record).toMatchObject({
      scope,
      source: { path: file },
      output: malformed,
      reason: expect.stringContaining('is not valid JSON'),
    });
  });
});
