/**
 * Focused integration tests: the idea refinement role actions and the decision publication over a
 * temporary refinement area. The agent runtime, Jira source and Git adapter are controlled; the
 * artifact storage is real. They establish the context every role receives, the produced artifacts,
 * the council's binding to one refined idea revision and the two source-updating publication
 * routes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ideaRoles, type AgentRuntime, type IdeaRole } from '../src/agent-runtime/index.js';
import type { JiraComment, JiraTransition } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { runnerOf } from './support/agent-runner.js';
import {
  refinedIdeaArtifact,
  retainedBriefArtifactPath,
  type RefinedIdea,
} from '../src/task-engine/actions/brief-writer/artifacts.js';
import { createBriefWriter } from '../src/task-engine/actions/brief-writer/index.js';
import {
  ideaCycleDirectory,
  ideaSubmissionInputFile,
} from '../src/task-engine/actions/idea-storage.js';
import {
  ideaCommunicationText,
  ideaDefinitionText,
  ideaStageGuidanceText,
  projectGuidanceInstruction,
} from '../src/task-engine/actions/idea-context.js';
import {
  decisionArtifact,
  ideaHandoffFile,
  type IdeaDecisionRecord,
  type IdeaHandoff,
} from '../src/task-engine/actions/publish-decision/artifacts.js';
import { createPublishDecision } from '../src/task-engine/actions/publish-decision/index.js';
import {
  purposeArtifact,
  type PurposeReport,
} from '../src/task-engine/actions/purpose-verifier/artifacts.js';
import { createPurposeVerifier } from '../src/task-engine/actions/purpose-verifier/index.js';
import {
  researchArtifact,
  type ResearchReport,
} from '../src/task-engine/actions/researcher/artifacts.js';
import { createResearcher } from '../src/task-engine/actions/researcher/index.js';
import {
  councilArtifacts,
  councilReviewers,
  type CouncilReport,
  type CouncilReviewer,
  type CouncilVerdict,
} from '../src/task-engine/actions/review-council/artifacts.js';
import {
  councilObjectionStandard,
  createCouncilReviewer,
} from '../src/task-engine/actions/review-council/index.js';
import { ideaInputDeclaration } from '../src/task-engine/actions/select-idea/artifacts.js';
import type { IdeaSelection } from '../src/task-engine/actions/select-idea/artifacts.js';
import {
  ideaRoundPlanDeclaration,
  type IdeaRoundPlan,
} from '../src/task-engine/actions/start-idea-round/artifacts.js';
import { scriptedJira } from './support/jira.js';

const profiles = {
  'purpose-verifier': 'nexus-purpose',
  researcher: 'nexus-research',
  'brief-writer': 'nexus-brief',
  'purpose-council': 'nexus-purpose-council',
  'evidence-council': 'nexus-evidence-council',
  'simplicity-council': 'nexus-simplicity-council',
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

const purposeReport: PurposeReport = {
  summary: 'The idea serves the project purpose.',
  conflicts: [],
  steering: ['Keep the scope small.'],
  sources: ['docs/purpose.md'],
  provisional: true,
  uncertainty: ['The charter is incomplete.'],
};

const researchReport: ResearchReport = {
  summary: 'Linters keep reviews focused.',
  findings: ['Teams catch style defects early.'],
  suggestions: ['Start with one rule set.'],
  options: ['Adopt the smallest lint configuration.'],
  sources: [{ title: 'Lint overview', link: 'https://example.com/lint', accessed: '2026-09-24' }],
};

/** One refined idea revision as the writer stores it. */
function refinedIdeaOf(revision: number, submission = 1) {
  return {
    revision,
    submission,
    cycle: revision,
    idea: 'Reviewers spend time on style defects; a lint gate would keep reviews on behaviour.',
    projectFit: 'The project already enforces checks in CI.',
    feasibility: `Enable the smallest lint gate first (revision ${String(revision)}).`,
    openQuestions: [`Is generated code in scope? (revision ${String(revision)})`],
    changeSummary: `Refined idea revision ${String(revision)}.`,
  };
}

/** One retained brief written in the shape that already stated one `idea` field. */
function previousBriefOf(revision: number, submission = 1) {
  return {
    revision,
    submission,
    cycle: revision,
    idea: 'Reviewers spend time on style defects; a lint gate would keep reviews on behaviour.',
    evidence: ['docs/purpose.md'],
    alternatives: ['Keep reviewing style by eye.'],
    scope: `Enable the smallest lint gate (revision ${String(revision)}).`,
    assumptions: [],
    changeSummary: `Brief revision ${String(revision)}.`,
  };
}

/** One retained brief written before `idea` replaced the three separate fields. */
function legacyBriefOf(revision: number, submission = 1) {
  return {
    revision,
    submission,
    cycle: revision,
    problem: 'Reviewers spend time on style defects.',
    value: 'Reviews focus on behaviour.',
    projectFit: 'The project already enforces checks in CI.',
    evidence: ['docs/purpose.md'],
    alternatives: ['Keep reviewing style by eye.'],
    scope: `Enable the smallest lint gate (revision ${String(revision)}).`,
    assumptions: [],
    changeSummary: `Brief revision ${String(revision)}.`,
  };
}

function councilReport(
  reviewer: CouncilReviewer,
  verdict: CouncilVerdict,
  brief: string,
  revision: number,
): CouncilReport {
  return {
    reviewer,
    verdict,
    summary: `${reviewer} review.`,
    findings:
      verdict === 'approve'
        ? []
        : [
            {
              criterion: `${reviewer} criterion`,
              evidence: `${reviewer} evidence`,
              correction: `${reviewer} correction`,
            },
          ],
    brief,
    revision,
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
  await writeFile(path.join(root, 'state', 'current-round.json'), JSON.stringify(plan));
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
    cycleDirectory: (cycle = plan.cycle) => ideaCycleDirectory(root, plan.submission, cycle),
    async write(cycle: number, declaration: { pathFromArtifactsRoot: string }, value: unknown) {
      const file = path.join(
        ideaCycleDirectory(root, plan.submission, cycle),
        declaration.pathFromArtifactsRoot,
      );
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

/** A controlled agent runtime answering each invocation with the supplied report. */
function scriptedRuntime(outputs: readonly unknown[]): {
  readonly runtime: AgentRuntime;
  readonly requests: {
    readonly profile: string;
    readonly workspace: string;
    readonly context: string;
  }[];
} {
  const requests: {
    readonly profile: string;
    readonly workspace: string;
    readonly context: string;
  }[] = [];
  let index = 0;
  return {
    requests,
    runtime: {
      async run(profile, workspace, context) {
        requests.push({ profile, workspace: workspace.root, context });
        const output = outputs[index];
        index += 1;
        return output === undefined
          ? { ok: false, fault: { message: 'No scripted agent output remains.' } }
          : ok({ output: JSON.stringify(output) });
      },
    },
  };
}

describe('idea role actions', () => {
  it('runs the purpose verifier with the captured idea, history and project guidance', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([purposeReport]);
    const action = createPurposeVerifier({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('reported');

    const request = agent.requests[0];
    expect(request?.profile).toBe('nexus-purpose');
    expect(request?.workspace).toBe(area.root);
    expect(request?.context).toContain('Add a lint gate');
    expect(request?.context).toContain('the author\u2019s idea');
    expect(request?.context).toContain('Prefer the smallest change.');
    expect(request?.context).toContain('Retained workspace history');
    expect(request?.context).toContain(path.join(area.root, 'worktree'));
    expect(await area.read(1, purposeArtifact.pathFromArtifactsRoot)).toEqual(purposeReport);
    // The invocation boundaries belong to the caller's agent runner, not to the action.
    expect(area.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'purpose-verifier',
          type: 'outcome',
          data: expect.objectContaining({
            cycle: 1,
            outcome: 'reported',
            detail: 'provisional project direction',
          }),
        }),
      ]),
    );
  });

  it('runs the researcher with the same captured context', async () => {
    const area = await refinementArea({ guidance: null });
    const agent = scriptedRuntime([researchReport]);
    const action = createResearcher({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('reported');

    expect(agent.requests[0]?.context).toContain('the author\u2019s idea');
    expect(agent.requests[0]?.context).not.toContain('AGENTS.md');
    expect(await area.read(1, researchArtifact.pathFromArtifactsRoot)).toEqual(researchReport);
  });

  it('writes the refined idea revision with the reports in force and reuses it when repeated', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const agent = scriptedRuntime([
      {
        idea: 'idea',
        projectFit: 'project fit',
        feasibility: 'feasibility',
        changeSummary: 'initial',
      },
    ]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('written');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain('The idea serves the project purpose.');
    expect(context).toContain('Linters keep reviews focused.');
    expect(context).toContain('No earlier council objections exist');
    expect(context).toContain('Keep detailed research in the research artifact');
    // The writer is told the refined idea's parts and what each states.
    const guidance = context.replace(/\s+/gu, ' ');
    expect(guidance).toContain('`projectFit` states why it belongs in this project');
    expect(guidance).toContain('`feasibility` states a plausible path');
    const refinedIdea = await area.read<Record<string, unknown>>(
      1,
      refinedIdeaArtifact.pathFromArtifactsRoot,
    );
    expect(refinedIdea).toMatchObject({
      revision: 1,
      submission: 1,
      cycle: 1,
      idea: 'idea',
      projectFit: 'project fit',
      feasibility: 'feasibility',
    });
    // Open questions are optional; a refined idea that states none keeps the field absent.
    expect(refinedIdea).not.toHaveProperty('openQuestions');

    // A repeated invocation reuses the revision it already wrote.
    await expect(action()).resolves.toBe('written');
    expect(agent.requests).toHaveLength(1);
  });

  it('gives the role a retained submission decision at its producer-owned path', async () => {
    const area = await refinementArea({ submission: 2 });
    const decisionFile = path.join(
      area.root,
      'artifacts/submissions/1',
      decisionArtifact.pathFromArtifactsRoot,
    );
    await mkdir(path.dirname(decisionFile), { recursive: true });
    await writeFile(
      decisionFile,
      JSON.stringify({
        decision: 'returned-to-author',
        strongestVerdict: 'idea_not_working',
        brief: 'brief.json',
        revision: 1,
        feedback: [],
        comment: null,
        source: {
          transition: { id: '22', to: 'Waiting for Feedback' },
          status: 'Waiting for Feedback',
          commentId: null,
        },
      }),
    );
    const agent = scriptedRuntime([purposeReport]);
    const action = createPurposeVerifier({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: () => undefined,
    });

    await expect(action()).resolves.toBe('reported');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain(`decision record: ${decisionFile}`);
    // The cycle-level path it is not saved at is never named.
    expect(context).not.toContain(path.join(area.cycleDirectory(), 'decision.json'));
  });

  it('carries the preceding objections and reuses the preceding reports in a minor cycle', async () => {
    const area = await refinementArea({ cycle: 2, route: 'minor' });
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(
          reviewer,
          reviewer === 'purpose' ? 'minor_corrections' : 'approve',
          refinedIdeaFile,
          1,
        ),
      );
    }
    const agent = scriptedRuntime([
      {
        idea: 'idea',
        projectFit: 'project fit',
        feasibility: 'feasibility',
        changeSummary: 'addressed the objection',
      },
    ]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('written');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain('Address each objection of the preceding council cycle');
    expect(context).toContain('purpose correction');
    expect(context).toContain('Latest earlier refined idea (cycle 1)');
    expect(context).toContain('Its cumulative change summary');
    expect(context).toContain('Purpose assessment in force (cycle 1)');
    // The writer keeps the short-default guidance on every revision, not only the first.
    const guidance = context.replace(/\s+/gu, ' ');
    expect(guidance).toContain('about 150-200 words');
    expect(guidance).toContain('one to three short sentences');
    expect(guidance).toContain('not a rigid cap');
    expect(guidance).toContain('keep any context the council needs to decide');
    // The prior objections arrive as corrections; their raw reports stay at their paths.
    expect(context).not.toContain('purpose evidence');
    expect(context).not.toContain('"verdict": "minor_corrections"');
    expect(context).toContain(
      path.join(area.cycleDirectory(1), councilArtifacts.purpose.pathFromArtifactsRoot),
    );
    expect(
      await area.read<RefinedIdea>(2, refinedIdeaArtifact.pathFromArtifactsRoot),
    ).toMatchObject({
      revision: 2,
      cycle: 2,
    });
  });

  it('reads a retained brief written before the idea field for the next revision', async () => {
    const area = await refinementArea({ cycle: 2, route: 'minor' });
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const legacyFile = await area.write(
      1,
      { pathFromArtifactsRoot: retainedBriefArtifactPath },
      legacyBriefOf(1),
    );
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(
          reviewer,
          reviewer === 'purpose' ? 'minor_corrections' : 'approve',
          legacyFile,
          1,
        ),
      );
    }
    const agent = scriptedRuntime([
      {
        idea: 'idea',
        projectFit: 'project fit',
        feasibility: 'feasibility',
        changeSummary: 'addressed the objection',
      },
    ]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('written');

    const context = agent.requests[0]?.context ?? '';
    // The retained revision is readable history, and its cumulative summary carries forward.
    expect(context).toContain(`cycle 1 refined idea revision: ${legacyFile}`);
    expect(context).toContain('Its cumulative change summary');
    expect(context).toContain('Brief revision 1.');
    // The retained artifact stays as it was; the new revision states the refined idea's parts.
    expect(await readFile(legacyFile, 'utf8')).toContain('"projectFit"');
    const written = await readFile(
      path.join(area.cycleDirectory(2), refinedIdeaArtifact.pathFromArtifactsRoot),
      'utf8',
    );
    expect(written).not.toContain('"problem"');
    expect(written).not.toContain('"value"');
    expect(written).not.toContain('"scope"');
  });

  it('reads a retained brief whose idea field stood alone as a refined idea without project fit', async () => {
    const area = await refinementArea({ cycle: 2, route: 'minor' });
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const retainedFile = await area.write(
      1,
      { pathFromArtifactsRoot: retainedBriefArtifactPath },
      previousBriefOf(1),
    );
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(reviewer, 'approve', retainedFile, 1),
      );
    }
    const agent = scriptedRuntime([
      {
        idea: 'idea',
        projectFit: 'project fit',
        feasibility: 'feasibility',
        changeSummary: 'addressed the objection',
      },
    ]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('written');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain(`cycle 1 refined idea revision: ${retainedFile}`);
    expect(context).toContain('Its cumulative change summary');
    expect(context).toContain('Brief revision 1.');
    expect(
      await area.read<RefinedIdea>(2, refinedIdeaArtifact.pathFromArtifactsRoot),
    ).toMatchObject({ revision: 2, cycle: 2, idea: 'idea' });
  });

  it('rejects writing a refined idea without the reports it must build on', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([{}]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: () => undefined,
    });

    await expect(action()).rejects.toThrow('needs the purpose assessment and research report');
    expect(agent.requests).toEqual([]);
  });

  it('supplies the authoritative idea definition verbatim, apart from the stage guidance', () => {
    expect(ideaDefinitionText).toContain(
      'An idea describes a desirable change in software, why it matters, and the principle ' +
        'behind it\u2014without yet committing to implementation.',
    );
    expect(ideaStageGuidanceText).not.toContain('An idea describes');
  });

  it('keeps the shared communication rule plain, selective and open to rejection', () => {
    expect(ideaCommunicationText).toContain('one point per statement');
    expect(ideaCommunicationText).toContain(
      'Research and cite relevant sources for substantive claims',
    );
    expect(ideaCommunicationText).toContain('fact-check incidental wording or nitpick details');
    expect(ideaCommunicationText).toContain('rejecting an unsuitable idea');
  });

  it('gives all six roles the same idea definition once before their own context', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const answers: Record<IdeaRole, unknown> = {
      'purpose-verifier': purposeReport,
      researcher: researchReport,
      'brief-writer': {
        idea: 'idea',
        projectFit: 'project fit',
        feasibility: 'feasibility',
        changeSummary: 'initial',
      },
      'purpose-council': { verdict: 'approve', summary: 'approved', findings: [] },
      'evidence-council': { verdict: 'approve', summary: 'approved', findings: [] },
      'simplicity-council': { verdict: 'approve', summary: 'approved', findings: [] },
    };
    const outcomes: Record<IdeaRole, string> = {
      'purpose-verifier': 'reported',
      researcher: 'reported',
      'brief-writer': 'written',
      'purpose-council': 'approve',
      'evidence-council': 'approve',
      'simplicity-council': 'approve',
    };
    const contexts: { readonly role: IdeaRole; readonly context: string }[] = [];
    const runtime: AgentRuntime = {
      async run(profile, _workspace, context) {
        const role = ideaRoles.find((candidate) => profiles[candidate] === profile);
        if (role === undefined) {
          return { ok: false, fault: { message: `Unknown idea role profile "${profile}".` } };
        }
        contexts.push({ role, context });
        return ok({ output: JSON.stringify(answers[role]) });
      },
    };
    const settings = {
      workspace: { root: area.root },
      runner: runnerOf(runtime),
      publish: () => undefined,
    };
    const actions: Record<IdeaRole, () => Promise<string>> = {
      'purpose-verifier': createPurposeVerifier(settings),
      researcher: createResearcher(settings),
      'brief-writer': createBriefWriter(settings),
      'purpose-council': createCouncilReviewer({ ...settings, reviewer: 'purpose' }),
      'evidence-council': createCouncilReviewer({ ...settings, reviewer: 'evidence' }),
      'simplicity-council': createCouncilReviewer({ ...settings, reviewer: 'simplicity' }),
    };

    for (const role of ideaRoles) {
      await expect(actions[role]()).resolves.toBe(outcomes[role]);
    }

    expect(contexts.map((entry) => entry.role)).toEqual([...ideaRoles]);
    for (const { role, context } of contexts) {
      // The one shared definition, the separate stage guidance and the communication rule arrive
      // exactly once each, ahead of the role's own context.
      expect(context.split(ideaDefinitionText)).toHaveLength(2);
      expect(context.split(ideaStageGuidanceText)).toHaveLength(2);
      expect(context.split(ideaCommunicationText)).toHaveLength(2);
      expect(
        context.startsWith(
          `${ideaDefinitionText}\n\n${ideaStageGuidanceText}\n\n${ideaCommunicationText}\n\n`,
        ),
      ).toBe(true);
      // The role-specific context follows it: the captured idea and the project guidance.
      expect(context.indexOf('Add a lint gate')).toBeGreaterThan(
        context.indexOf(ideaStageGuidanceText),
      );
      expect(context).toContain('Prefer the smallest change.');
      // The project guidance arrives once, with the project's own AGENTS.md text.
      expect(context.split(projectGuidanceInstruction)).toHaveLength(2);
      // The one shared objection standard reaches every council invocation and no other role.
      expect(context.split(councilObjectionStandard)).toHaveLength(
        role.endsWith('-council') ? 2 : 1,
      );
    }
  });
});

describe('council reviewers', () => {
  it('binds its verdict to the exact refined idea revision and hides the pending siblings', async () => {
    const area = await refinementArea();
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    const sibling = await area.write(
      1,
      councilArtifacts.evidence,
      councilReport('evidence', 'approve', refinedIdeaFile, 1),
    );
    const agent = scriptedRuntime([
      {
        verdict: 'minor_corrections',
        summary: 'purpose review',
        findings: [{ criterion: 'fit', evidence: 'docs', correction: 'narrow the scope' }],
      },
    ]);
    const action = createCouncilReviewer({
      reviewer: 'purpose',
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('minor_corrections');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain(refinedIdeaFile);
    expect(context).toContain('the author\u2019s idea');
    expect(context).not.toContain(sibling);
    expect(context).not.toContain('evidence council result');
    expect(agent.requests[0]?.profile).toBe('nexus-purpose-council');
    expect(
      await area.read<CouncilReport>(1, councilArtifacts.purpose.pathFromArtifactsRoot),
    ).toEqual(
      expect.objectContaining({
        reviewer: 'purpose',
        verdict: 'minor_corrections',
        brief: refinedIdeaFile,
        revision: 1,
      }),
    );
    expect(area.events.at(-1)).toMatchObject({
      source: 'PurposeCouncil',
      type: 'outcome',
      data: { outcome: 'minor_corrections', cycle: 1 },
    });
  });

  it('reuses its saved result for the same refined idea revision', async () => {
    const area = await refinementArea();
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    await area.write(
      1,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'major_rework', refinedIdeaFile, 1),
    );
    const agent = scriptedRuntime([{ verdict: 'approve', summary: '', findings: [] }]);
    const action = createCouncilReviewer({
      reviewer: 'simplicity',
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('major_rework');
    expect(agent.requests).toEqual([]);
    // The reused outcome names the verdict artifact the reviewer saved, not the input revision.
    expect(area.events.at(-1)).toMatchObject({
      source: 'SimplicityCouncil',
      type: 'outcome',
      data: {
        outcome: 'major_rework',
        artifact: {
          path: path.join(area.cycleDirectory(), councilArtifacts.simplicity.pathFromArtifactsRoot),
        },
      },
    });
  });

  it('reviews a retained brief written before the idea field as the refined idea it expresses', async () => {
    const area = await refinementArea();
    const legacyFile = await area.write(
      1,
      { pathFromArtifactsRoot: retainedBriefArtifactPath },
      legacyBriefOf(1),
    );
    const agent = scriptedRuntime([{ verdict: 'approve', summary: 'approved', findings: [] }]);
    const action = createCouncilReviewer({
      reviewer: 'evidence',
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: () => undefined,
    });

    await expect(action()).resolves.toBe('approve');

    const context = agent.requests[0]?.context ?? '';
    // Its problem and value read as the idea, and its project fit and scope keep their own parts.
    expect(context).toContain('Reviewers spend time on style defects. Reviews focus on behaviour.');
    expect(context).toContain('"projectFit": "The project already enforces checks in CI."');
    expect(context).toContain('"feasibility": "Enable the smallest lint gate (revision 1)."');
    // The retained shape does not leak into the reviewer's reading of the revision.
    expect(context).not.toContain('"problem"');
    expect(context).not.toContain('"value"');
    expect(
      await area.read<CouncilReport>(1, councilArtifacts.evidence.pathFromArtifactsRoot),
    ).toEqual(
      expect.objectContaining({
        reviewer: 'evidence',
        verdict: 'approve',
        brief: legacyFile,
        revision: 1,
      }),
    );
  });

  it('reviews a retained brief whose idea field stood alone without a project fit', async () => {
    const area = await refinementArea();
    const retainedFile = await area.write(
      1,
      { pathFromArtifactsRoot: retainedBriefArtifactPath },
      previousBriefOf(1),
    );
    const agent = scriptedRuntime([{ verdict: 'approve', summary: 'approved', findings: [] }]);
    const action = createCouncilReviewer({
      reviewer: 'purpose',
      workspace: { root: area.root },
      runner: runnerOf(agent.runtime),
      publish: () => undefined,
    });

    await expect(action()).resolves.toBe('approve');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain(
      '"idea": "Reviewers spend time on style defects; a lint gate would keep reviews on behaviour."',
    );
    // A retained brief that carried no separate project fit reads as one that states none.
    expect(context).toContain('"projectFit": null');
    expect(context).toContain('"feasibility": "Enable the smallest lint gate (revision 1)."');
    // The retained brief's supporting sections stay out of the refined idea the reviewer reads.
    expect(context).not.toContain('"alternatives"');
    expect(context).not.toContain('"assumptions"');
    expect(
      await area.read<CouncilReport>(1, councilArtifacts.purpose.pathFromArtifactsRoot),
    ).toEqual(
      expect.objectContaining({
        reviewer: 'purpose',
        verdict: 'approve',
        brief: retainedFile,
        revision: 1,
      }),
    );
  });

  it('rejects an approval with unresolved findings and a nonapproval without any', async () => {
    const area = await refinementArea();
    await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    const withFindings = scriptedRuntime([
      {
        verdict: 'approve',
        summary: 'approved',
        findings: [{ criterion: 'a', evidence: 'b', correction: 'c' }],
      },
    ]);
    await expect(
      createCouncilReviewer({
        reviewer: 'purpose',
        workspace: { root: area.root },
        runner: runnerOf(withFindings.runtime),
        publish: () => undefined,
      })(),
    ).rejects.toThrow('while naming unresolved findings');

    const withoutFindings = scriptedRuntime([
      { verdict: 'major_rework', summary: 'rework', findings: [] },
    ]);
    await expect(
      createCouncilReviewer({
        reviewer: 'evidence',
        workspace: { root: area.root },
        runner: runnerOf(withoutFindings.runtime),
        publish: () => undefined,
      })(),
    ).rejects.toThrow('without naming a criterion, evidence and correction');
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

  /** One publication over the supplied refinement area, selection and transition lookups. */
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

  it('publishes the approved refined idea, moves the item and leaves a handoff of references', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(reviewer, 'approve', refinedIdeaFile, 1),
      );
    }
    const jira = source();

    await expect(publication(area, jira)({ decision: 'approved' })).resolves.toBe('approved');

    // Publication uses the captured snapshot: no issue, comment or transition read reaches Jira.
    expect(jira.calls.some((call) => call.startsWith('read:'))).toBe(false);
    expect(jira.calls.some((call) => call.startsWith('comments:'))).toBe(false);
    expect(jira.transitions).toEqual(['21']);
    expect(jira.comments).toHaveLength(1);
    const published = JSON.stringify(jira.comments[0]?.body);
    expect(published).toContain('Approved refined idea (revision 1)');
    expect(published.match(/Idea: /gu)).toHaveLength(1);
    expect(published).toContain(
      'Idea: Reviewers spend time on style defects; a lint gate would keep reviews on behaviour.',
    );
    expect(published).toContain('Project fit: The project already enforces checks in CI.');
    expect(published).toContain('Feasibility: Enable the smallest lint gate first (revision 1).');
    expect(published).toContain('Open questions:');
    expect(published).toContain('- Is generated code in scope? (revision 1)');
    expect(published).toContain('Council cycles used: 1');
    expect(published).toContain('What refinement changed: Refined idea revision 1.');
    expect(published).not.toContain('purpose review');

    const decision = JSON.parse(
      await readFile(
        path.join(area.root, 'artifacts/submissions/1', decisionArtifact.pathFromArtifactsRoot),
        'utf8',
      ),
    ) as IdeaDecisionRecord;
    expect(decision).toMatchObject({
      decision: 'approved',
      strongestVerdict: 'approve',
      brief: refinedIdeaFile,
      revision: 1,
      source: { transition: { id: '21', to: 'Draft' }, status: 'Draft', commentId: 'c2' },
    });
    expect(decision.feedback).toHaveLength(3);
    const handoff = JSON.parse(
      await readFile(path.join(area.root, ideaHandoffFile), 'utf8'),
    ) as IdeaHandoff;
    expect(handoff).toMatchObject({
      issue: { id: '10518', key: 'NEX-1' },
      capturedInput: ideaSubmissionInputFile(area.root, 1),
      brief: refinedIdeaFile,
    });
    expect(handoff.purpose).toBe(
      path.join(area.cycleDirectory(), purposeArtifact.pathFromArtifactsRoot),
    );
  });

  it('publishes a retained brief written before the idea field as the refined idea it expresses', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const legacyFile = await area.write(
      1,
      { pathFromArtifactsRoot: retainedBriefArtifactPath },
      legacyBriefOf(1),
    );
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(reviewer, 'approve', legacyFile, 1),
      );
    }
    const jira = source();

    await expect(publication(area, jira)({ decision: 'approved' })).resolves.toBe('approved');

    const published = JSON.stringify(jira.comments[0]?.body);
    expect(published.match(/Idea: /gu)).toHaveLength(1);
    expect(published).toContain(
      'Idea: Reviewers spend time on style defects. Reviews focus on behaviour.',
    );
    expect(published).toContain('Project fit: The project already enforces checks in CI.');
    expect(published).toContain('Feasibility: Enable the smallest lint gate (revision 1).');
    expect(published).not.toContain('Problem:');
    expect(published).not.toContain('Expected value:');
    // Publication reads the retained artifact; it never rewrites it.
    expect(await readFile(legacyFile, 'utf8')).toContain('"projectFit"');
  });

  it('returns only human-facing feedback and moves the item to the waiting status', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    await area.write(
      1,
      councilArtifacts.purpose,
      councilReport('purpose', 'approve', refinedIdeaFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.evidence,
      councilReport('evidence', 'minor_corrections', refinedIdeaFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'idea_not_working', refinedIdeaFile, 1),
    );
    const jira = source();

    await expect(publication(area, jira)({ decision: 'returned-to-author' })).resolves.toBe(
      'waiting-for-feedback',
    );

    expect(jira.transitions).toEqual(['22']);
    const published = JSON.stringify(jira.comments[0]?.body);
    expect(published).toContain('Returned for feedback: the council did not approve this idea');
    expect(published).toContain('Latest refined idea (revision 1)');
    expect(published).toContain(
      'Reviewers spend time on style defects; a lint gate would keep reviews on behaviour.',
    );
    expect(published).toContain('Project fit: The project already enforces checks in CI.');
    expect(published).toContain('Feasibility: Enable the smallest lint gate first (revision 1).');
    expect(published).toContain('What stopped approval:');
    expect(published).toContain('- simplicity correction');
    expect(published).toContain('back to \\"Idea\\" to resubmit it.');
    expect(published).toContain('Council cycles used: 1');
    expect(published).toContain('What refinement changed: Refined idea revision 1.');
    // The reviewer's summary, verdict name and criterion label stay internal.
    expect(published).not.toContain('simplicity review');
    expect(published).not.toContain('idea_not_working');
    expect(published).not.toContain('simplicity criterion');
    // The return reports the refusal to approve, not a judgment of the idea's worth.
    expect(published).not.toContain('worthwhile');
    // Other reviewers' feedback stays in artifacts.
    expect(published).not.toContain('evidence correction');
    // Raw council evidence and code citations stay in artifacts.
    expect(published).not.toContain('simplicity evidence');
    expect(await area.exists(ideaHandoffFile)).toBe(false);
    expect(
      JSON.parse(
        await readFile(
          path.join(area.root, 'artifacts/submissions/1', decisionArtifact.pathFromArtifactsRoot),
          'utf8',
        ),
      ),
    ).toMatchObject({ decision: 'returned-to-author', strongestVerdict: 'idea_not_working' });
  });

  it('reports exhaustion with the latest idea, cycles used, change summary and corrections', async () => {
    const area = await refinementArea({ cycle: 2, route: 'minor' });
    const refinedIdeaFile = await area.write(2, refinedIdeaArtifact, refinedIdeaOf(2));
    await area.write(
      2,
      councilArtifacts.purpose,
      councilReport('purpose', 'minor_corrections', refinedIdeaFile, 2),
    );
    await area.write(
      2,
      councilArtifacts.evidence,
      councilReport('evidence', 'minor_corrections', refinedIdeaFile, 2),
    );
    await area.write(
      2,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'approve', refinedIdeaFile, 2),
    );
    const jira = source();

    await expect(publication(area, jira)({ decision: 'unable-to-converge' })).resolves.toBe(
      'waiting-for-feedback',
    );

    const published = JSON.stringify(jira.comments[0]?.body);
    expect(published).toContain(
      'Attempts exhausted after 2 cycles: the council did not approve this idea.',
    );
    expect(published).toContain('Latest refined idea (revision 2)');
    expect(published).toContain(
      'Reviewers spend time on style defects; a lint gate would keep reviews on behaviour.',
    );
    expect(published).toContain('Open questions:');
    expect(published).toContain('- Is generated code in scope? (revision 2)');
    // The returned comment never publishes the research detail the refined idea leaves out.
    expect(published).not.toContain('Strongest supporting evidence');
    expect(published).not.toContain('Meaningful alternatives');
    expect(published).toContain('What refinement changed: Refined idea revision 2.');
    expect(published).toContain('Council cycles used: 2');
    expect(published).toContain('What stopped approval:');
    // Every non-approving reviewer's material objection reaches the exhausted return.
    expect(published).toContain('- purpose correction');
    expect(published).toContain('- evidence correction');
    // Criterion labels, verdict names and raw evidence stay in the artifacts.
    expect(published).not.toContain('purpose criterion');
    expect(published).not.toContain('evidence criterion');
    expect(published).not.toContain('minor_corrections');
    expect(published).not.toContain('purpose evidence');
    expect(published).not.toContain('evidence evidence');
    expect(jira.transitions).toEqual(['22']);
    expect(
      JSON.parse(
        await readFile(
          path.join(area.root, 'artifacts/submissions/1', decisionArtifact.pathFromArtifactsRoot),
          'utf8',
        ),
      ),
    ).toMatchObject({ decision: 'unable-to-converge', strongestVerdict: 'minor_corrections' });
  });

  it('keeps every distinct material correction once on an exhausted return', async () => {
    const area = await refinementArea({ cycle: 2, route: 'minor' });
    const refinedIdeaFile = await area.write(2, refinedIdeaArtifact, refinedIdeaOf(2));
    const shared = {
      criterion: 'internal criterion',
      evidence: 'internal evidence',
      correction: 'Narrow the promise to the smallest useful scope.',
    };
    await area.write(2, councilArtifacts.purpose, {
      ...councilReport('purpose', 'minor_corrections', refinedIdeaFile, 2),
      findings: [shared],
    });
    await area.write(2, councilArtifacts.evidence, {
      ...councilReport('evidence', 'minor_corrections', refinedIdeaFile, 2),
      findings: [
        shared,
        {
          criterion: 'another internal criterion',
          evidence: 'another internal evidence',
          correction: 'Say how the idea differs from the existing check.',
        },
      ],
    });
    await area.write(
      2,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'approve', refinedIdeaFile, 2),
    );
    const jira = source();

    await expect(publication(area, jira)({ decision: 'unable-to-converge' })).resolves.toBe(
      'waiting-for-feedback',
    );

    const published = JSON.stringify(jira.comments[0]?.body);
    // Two reviewers requesting the same change are one request; distinct corrections all stay.
    expect(published.match(/Narrow the promise to the smallest useful scope\./gu)).toHaveLength(1);
    expect(published).toContain('Say how the idea differs from the existing check.');
    // Criterion labels and evidence never reach the author.
    expect(published).not.toContain('internal criterion');
    expect(published).not.toContain('internal evidence');
  });

  it('reuses a decision it already recorded instead of publishing again', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(reviewer, 'approve', refinedIdeaFile, 1),
      );
    }
    const jira = source();
    await publication(area, jira)({ decision: 'approved' });
    const comments = jira.comments.length;

    await expect(publication(area, jira)({ decision: 'approved' })).resolves.toBe('approved');

    expect(jira.comments).toHaveLength(comments);
    expect(jira.transitions).toEqual(['21']);
  });

  it('completes an interrupted approval handoff when the saved decision is retried', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(reviewer, 'approve', refinedIdeaFile, 1),
      );
    }
    const jira = source();
    // An obstruction where the handoff belongs makes the approval's handoff write fail after the
    // decision, its comment and its transition were saved.
    await mkdir(path.join(area.root, ideaHandoffFile), { recursive: true });
    await expect(publication(area, jira)({ decision: 'approved' })).rejects.toThrow();
    expect(
      await readFile(
        path.join(area.root, 'artifacts/submissions/1', decisionArtifact.pathFromArtifactsRoot),
        'utf8',
      ),
    ).toContain('"approved"');

    // The obstruction goes away; the repeated publication establishes the handoff before it
    // reports the same outcome, and it repeats none of the source updates.
    await rm(path.join(area.root, ideaHandoffFile), { recursive: true, force: true });
    const comments = jira.comments.length;
    await expect(publication(area, jira)({ decision: 'approved' })).resolves.toBe('approved');

    expect(jira.comments).toHaveLength(comments);
    expect(jira.transitions).toEqual(['21']);
    const handoff = JSON.parse(
      await readFile(path.join(area.root, ideaHandoffFile), 'utf8'),
    ) as IdeaHandoff;
    expect(handoff).toMatchObject({
      issue: { id: '10518', key: 'NEX-1' },
      brief: refinedIdeaFile,
      decision: path.join(
        area.root,
        'artifacts/submissions/1',
        decisionArtifact.pathFromArtifactsRoot,
      ),
    });
  });

  it('refuses an approval the council did not grant and a council set for another revision', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const refinedIdeaFile = await area.write(1, refinedIdeaArtifact, refinedIdeaOf(1));
    await area.write(
      1,
      councilArtifacts.purpose,
      councilReport('purpose', 'approve', refinedIdeaFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.evidence,
      councilReport('evidence', 'major_rework', refinedIdeaFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'approve', refinedIdeaFile, 1),
    );
    const jira = source();

    await expect(publication(area, jira)({ decision: 'approved' })).rejects.toThrow(
      'Approval requires every council reviewer to approve',
    );
    expect(jira.comments).toEqual([]);

    // A council result bound to another refined idea revision invalidates the set.
    await area.write(
      1,
      councilArtifacts.evidence,
      councilReport('evidence', 'approve', path.join(area.root, 'other.json'), 2),
    );
    await expect(publication(area, jira)({ decision: 'unable-to-converge' })).rejects.toThrow(
      'not the current',
    );
  });
});

describe('idea artifact declarations', () => {
  it('accept the documents the actions write', async () => {
    expect(ideaInputDeclaration.schema.safeParse(capturedInput).success).toBe(true);
    expect(
      ideaRoundPlanDeclaration.schema.safeParse({ submission: 1, cycle: 1, route: 'new', profiles })
        .success,
    ).toBe(true);
  });
});
