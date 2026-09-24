/**
 * Focused integration tests: the idea refinement role actions and the decision publication over a
 * temporary refinement area. The agent runtime, Jira source and Git adapter are controlled; the
 * artifact storage is real. They establish the context every role receives, the produced artifacts,
 * the council's binding to one brief revision and the two source-updating publication routes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../src/agent-runtime/index.js';
import type { JiraComment, JiraTransition } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { briefArtifact, type Brief } from '../src/task-engine/actions/brief-writer/artifacts.js';
import { createBriefWriter } from '../src/task-engine/actions/brief-writer/index.js';
import {
  ideaCycleDirectory,
  ideaSubmissionInputFile,
} from '../src/task-engine/actions/idea-storage.js';
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
import { createCouncilReviewer } from '../src/task-engine/actions/review-council/index.js';
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

function briefOf(revision: number, submission = 1): Brief {
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
      runtime: agent.runtime,
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
    expect(area.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'PurposeVerifier',
          type: 'agent-started',
          data: expect.objectContaining({ role: 'purpose-verifier', idea: 'NEX-1' }),
        }),
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
      runtime: agent.runtime,
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('reported');

    expect(agent.requests[0]?.context).toContain('the author\u2019s idea');
    expect(agent.requests[0]?.context).not.toContain('AGENTS.md');
    expect(await area.read(1, researchArtifact.pathFromArtifactsRoot)).toEqual(researchReport);
  });

  it('writes the brief revision with the reports in force and reuses it when repeated', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const agent = scriptedRuntime([
      {
        problem: 'problem',
        value: 'value',
        projectFit: 'fit',
        evidence: ['docs/purpose.md'],
        alternatives: [],
        scope: 'scope',
        assumptions: [],
        changeSummary: 'initial',
      },
    ]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runtime: agent.runtime,
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('written');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain('The idea serves the project purpose.');
    expect(context).toContain('Linters keep reviews focused.');
    expect(context).toContain('No earlier council objections exist');
    const brief = await area.read<Brief>(1, briefArtifact.pathFromArtifactsRoot);
    expect(brief).toMatchObject({ revision: 1, submission: 1, cycle: 1, problem: 'problem' });

    // A repeated invocation reuses the revision it already wrote.
    await expect(action()).resolves.toBe('written');
    expect(agent.requests).toHaveLength(1);
  });

  it('carries the preceding objections and reuses the preceding reports in a minor cycle', async () => {
    const area = await refinementArea({ cycle: 2, route: 'minor' });
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const briefFile = await area.write(1, briefArtifact, briefOf(1));
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(
          reviewer,
          reviewer === 'purpose' ? 'minor_corrections' : 'approve',
          briefFile,
          1,
        ),
      );
    }
    const agent = scriptedRuntime([
      {
        problem: 'problem',
        value: 'value',
        projectFit: 'fit',
        evidence: [],
        alternatives: [],
        scope: 'scope',
        assumptions: [],
        changeSummary: 'addressed the objection',
      },
    ]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runtime: agent.runtime,
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('written');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain('Address each objection of the preceding council cycle');
    expect(context).toContain('purpose correction');
    expect(context).toContain('Latest earlier brief revision (cycle 1)');
    expect(context).toContain('Purpose assessment in force (cycle 1)');
    expect(await area.read<Brief>(2, briefArtifact.pathFromArtifactsRoot)).toMatchObject({
      revision: 2,
      cycle: 2,
    });
  });

  it('rejects writing a brief without the reports it must build on', async () => {
    const area = await refinementArea();
    const agent = scriptedRuntime([{}]);
    const action = createBriefWriter({
      workspace: { root: area.root },
      runtime: agent.runtime,
      publish: () => undefined,
    });

    await expect(action()).rejects.toThrow('needs the purpose assessment and research report');
    expect(agent.requests).toEqual([]);
  });
});

describe('council reviewers', () => {
  it('binds its verdict to the exact brief revision and hides the pending siblings', async () => {
    const area = await refinementArea();
    const briefFile = await area.write(1, briefArtifact, briefOf(1));
    const sibling = await area.write(
      1,
      councilArtifacts.evidence,
      councilReport('evidence', 'approve', briefFile, 1),
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
      runtime: agent.runtime,
      publish: (event) => area.events.push(event),
    });

    await expect(action()).resolves.toBe('minor_corrections');

    const context = agent.requests[0]?.context ?? '';
    expect(context).toContain(briefFile);
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
        brief: briefFile,
        revision: 1,
      }),
    );
    expect(area.events.at(-1)).toMatchObject({
      source: 'PurposeCouncil',
      type: 'outcome',
      data: { outcome: 'minor_corrections', cycle: 1 },
    });
  });

  it('reuses its saved result for the same brief revision', async () => {
    const area = await refinementArea();
    const briefFile = await area.write(1, briefArtifact, briefOf(1));
    await area.write(
      1,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'major_rework', briefFile, 1),
    );
    const agent = scriptedRuntime([{ verdict: 'approve', summary: '', findings: [] }]);
    const action = createCouncilReviewer({
      reviewer: 'simplicity',
      workspace: { root: area.root },
      runtime: agent.runtime,
      publish: () => undefined,
    });

    await expect(action()).resolves.toBe('major_rework');
    expect(agent.requests).toEqual([]);
  });

  it('rejects an approval with unresolved findings and a nonapproval without any', async () => {
    const area = await refinementArea();
    await area.write(1, briefArtifact, briefOf(1));
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
        runtime: withFindings.runtime,
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
        runtime: withoutFindings.runtime,
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

  it('publishes the approved brief, moves the item and leaves a handoff of references', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const briefFile = await area.write(1, briefArtifact, briefOf(1));
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(reviewer, 'approve', briefFile, 1),
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
    expect(published).toContain('Approved idea brief (revision 1)');
    expect(published).toContain('Enable the smallest lint gate (revision 1)');
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
      brief: briefFile,
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
      brief: briefFile,
    });
    expect(handoff.purpose).toBe(
      path.join(area.cycleDirectory(), purposeArtifact.pathFromArtifactsRoot),
    );
  });

  it('returns only human-facing feedback and moves the item to the waiting status', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const briefFile = await area.write(1, briefArtifact, briefOf(1));
    await area.write(
      1,
      councilArtifacts.purpose,
      councilReport('purpose', 'approve', briefFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.evidence,
      councilReport('evidence', 'minor_corrections', briefFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'idea_not_working', briefFile, 1),
    );
    const jira = source();

    await expect(publication(area, jira)({ decision: 'returned-to-author' })).resolves.toBe(
      'waiting-for-feedback',
    );

    expect(jira.transitions).toEqual(['22']);
    const published = JSON.stringify(jira.comments[0]?.body);
    expect(published).toContain('simplicity correction');
    expect(published).toContain('back to \\"Idea\\" to resubmit it.');
    // Other reviewers' feedback stays in artifacts.
    expect(published).not.toContain('evidence correction');
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

  it('reuses a decision it already recorded instead of publishing again', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const briefFile = await area.write(1, briefArtifact, briefOf(1));
    for (const reviewer of councilReviewers) {
      await area.write(
        1,
        councilArtifacts[reviewer],
        councilReport(reviewer, 'approve', briefFile, 1),
      );
    }
    const jira = source();
    await publication(area, jira)({ decision: 'approved' });
    const comments = jira.comments.length;

    await expect(publication(area, jira)({ decision: 'approved' })).resolves.toBe('approved');

    expect(jira.comments).toHaveLength(comments);
    expect(jira.transitions).toEqual(['21']);
  });

  it('refuses an approval the council did not grant and a council set for another revision', async () => {
    const area = await refinementArea();
    await area.write(1, purposeArtifact, purposeReport);
    await area.write(1, researchArtifact, researchReport);
    const briefFile = await area.write(1, briefArtifact, briefOf(1));
    await area.write(
      1,
      councilArtifacts.purpose,
      councilReport('purpose', 'approve', briefFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.evidence,
      councilReport('evidence', 'major_rework', briefFile, 1),
    );
    await area.write(
      1,
      councilArtifacts.simplicity,
      councilReport('simplicity', 'approve', briefFile, 1),
    );
    const jira = source();

    await expect(publication(area, jira)({ decision: 'approved' })).rejects.toThrow(
      'Approval requires every council reviewer to approve',
    );
    expect(jira.comments).toEqual([]);

    // A council result bound to another brief revision invalidates the set.
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
