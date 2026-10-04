import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import type { GitHubAdapter, PullRequest } from '../../../../adapters/github.js';
import type { JiraAdapter } from '../../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import {
  stagePlanArtifact,
  stageResultArtifact,
  type PlannedTask,
} from '../../preparation/artifacts.js';
import {
  readStageArtifact,
  readStagePlan,
  stageRoot,
  stageWorktree,
} from '../../preparation/storage.js';
import {
  applyTransition,
  publishDocument,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
} from '../../source.js';
import { readHandoff, readSelection, writeHandoff } from '../state.js';
import type { ParentHandoff } from '../../select-work/artifacts.js';

/**
 * HandoffImplementation is the parent-owned Architecture handoff: it publishes the stage's changed
 * authoritative documents in a documentation-only pull request and confirms merge/required-check
 * evidence before it creates the linked implementation tickets, ranks prerequisites before their
 * dependents, retains every created identity and closes the original issue with the links. A
 * skip without changed documents creates no empty pull request. Uncertain creation is reconciled
 * against the retained tickets before anything is retried.
 */

export type ImplementationHandoffSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The delivery repository identity and base branch the documents merge into. */
  readonly repository: string;
  readonly baseBranch: string;
  /** The configured implementation-ticket creation and linking settings. */
  readonly implementation: {
    readonly issueType: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly linkType: string;
  };
  /** The configured completed status the original issue reaches after the handoff. */
  readonly doneStatus: string;
  /** The configured merge/check wait bounds. */
  readonly completion: {
    readonly pollIntervalSeconds: number;
    readonly waitLimitSeconds: number;
  };
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
  readonly wait: (milliseconds: number) => Promise<void>;
};

/** One Jira document whose paragraphs are the supplied text's lines. */
function documentOf(text: string): Readonly<Record<string, unknown>> {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split('\n')
      .map((line) =>
        line.trim() === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
  };
}

/** The implementation ticket description one planned task produces. */
function ticketDescription(task: PlannedTask, prerequisites: readonly string[]): string {
  return [
    task.summary,
    '',
    `Scope: ${task.scope}`,
    '',
    'Completion criteria:',
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    ...(prerequisites.length === 0 ? [] : ['', `Prerequisites: ${prerequisites.join(', ')}`]),
  ].join('\n');
}

/** Create the parent-owned Architecture handoff. */
export function createImplementationHandoff(settings: ImplementationHandoffSettings): BoundAction {
  return async () => {
    const selection = await readSelection(settings.selectionFile);
    const root = stageRoot(selection.workspace.root, 'architecture');
    const worktree = stageWorktree(selection.workspace.root, 'architecture');
    const plan = await readStagePlan(root);
    if (plan === null) {
      throw new Error(`No architecture round plan exists under "${root}" to hand off.`);
    }
    const result = await readStageArtifact(root, plan.round, stageResultArtifact);
    if (result === null) {
      throw new Error(`No architecture result exists under "${root}" to hand off.`);
    }
    if (result.outcome !== 'accepted' && result.outcome !== 'skipped') {
      throw new Error(
        `The architecture result is "${result.outcome}"; only an accepted or skipped result hands ` +
          'off.',
      );
    }
    const tasks = (await readStageArtifact(root, plan.round, stagePlanArtifact)) ?? [];
    if (tasks.length === 0) {
      throw new Error('The architecture result carries no implementation plan to hand off.');
    }
    const retained = await readHandoff(selection.workspace.root);
    const handoff: ParentHandoff = retained ?? {
      stage: 'architecture',
      upstreamReturns: 0,
      feedback: null,
      tickets: [],
      publications: [],
    };

    /** Report a condition that prevents the handoff. */
    async function failed(reason: string): Promise<'failed'> {
      settings.publish({ source: 'implementation-handoff', type: 'failed', data: { reason } });
      return 'failed';
    }

    // Publish the changed authoritative documents as a documentation-only pull request. A stage
    // that concluded existing documents suffice names no changed file and creates no empty PR.
    if (result.outputs.length > 0) {
      const publication = await publishDocuments(result.outputs.map((output) => output.path));
      if (publication.kind === 'failed') {
        return failed(publication.reason);
      }
    }

    // Create the implementation tickets in plan order, reconciling any retained identity with the
    // planned task before creating anything new.
    const tickets: ParentHandoff['tickets'] = [...handoff.tickets];
    for (const [index, task] of tasks.entries()) {
      const existing = tickets[index];
      if (existing !== undefined) {
        if (existing.summary !== task.summary) {
          return failed(
            `The retained implementation ticket ${existing.key} is "${existing.summary}" while ` +
              `planned task ${String(index + 1)} is "${task.summary}"; the handoff cannot ` +
              'reconcile them.',
          );
        }
        continue;
      }
      const prerequisites = task.prerequisites.flatMap((prerequisite) => {
        const ticket = tickets[prerequisite];
        return ticket === undefined ? [] : [ticket.key];
      });
      const created = await settings.jira.createIssue({
        issuetype: { name: settings.implementation.issueType },
        summary: task.summary,
        description: documentOf(ticketDescription(task, prerequisites)),
        ...(settings.implementation.labels.length === 0
          ? {}
          : { labels: [...settings.implementation.labels] }),
      });
      if (!created.ok) {
        return failed(created.fault.message);
      }
      const identity = { key: created.value.key, issueId: created.value.id, summary: task.summary };
      // Retain the identity before any dependent operation, so an interruption reuses it.
      tickets.push(identity);
      await writeHandoff(selection.workspace.root, { ...handoff, tickets });

      const linked = await settings.jira.linkIssues(
        created.value.id,
        selection.source.issueId,
        settings.implementation.linkType,
      );
      if (!linked.ok) {
        return failed(linked.fault.message);
      }
      if (prerequisites.length > 0) {
        const ranked = await settings.jira.rankIssue(created.value.id, {
          after: prerequisites.at(-1) as string,
        });
        if (!ranked.ok) {
          return failed(ranked.fault.message);
        }
      }
      const issue = await readIssue(settings.jira, created.value.id);
      if (statusNameOf(issue) !== settings.implementation.status) {
        const transition = await transitionInto(
          settings.jira,
          issue,
          settings.implementation.status,
        );
        if (transition.kind === 'blocked') {
          return failed(transition.reason);
        }
        await applyTransition(settings.jira, issue.id, transition.transition);
      }
    }

    // Close the original with the completed handoff and every implementation link.
    const source = await readIssue(settings.jira, selection.source.issueId);
    const linkList = tickets.map((ticket) => `${ticket.key}: ${ticket.summary}`).join('\n');
    const comment = [
      'Preparation complete. Implementation tickets:',
      ...tickets.map((ticket) => `- ${ticket.key}: ${ticket.summary}`),
      ...(handoff.publications.some((publication) => publication.kind === 'documentation-pr')
        ? [
            '',
            `Documentation PR: ${
              handoff.publications.find((publication) => publication.kind === 'documentation-pr')
                ?.id ?? ''
            }`,
          ]
        : []),
    ].join('\n');
    await publishDocument(
      settings.jira,
      selection.source.issueId,
      await readComments(settings.jira, selection.source.issueId),
      documentOf(comment),
    );
    if (statusNameOf(source) !== settings.doneStatus) {
      const transition = await transitionInto(settings.jira, source, settings.doneStatus);
      if (transition.kind === 'blocked') {
        return failed(transition.reason);
      }
      await applyTransition(settings.jira, source.id, transition.transition);
    }
    await writeHandoff(selection.workspace.root, { ...handoff, tickets });
    settings.publish({
      source: 'implementation-handoff',
      type: 'handed-off',
      data: {
        task: selection.taskKey,
        tickets: tickets.map((ticket) => ticket.key),
        links: linkList,
      },
    });
    return 'handed-off';

    /**
     * Publish the changed authoritative documents: commit and push the stage branch, reuse or open
     * the documentation-only pull request and wait for its merge and required checks.
     */
    async function publishDocuments(
      documents: readonly string[],
    ): Promise<{ readonly kind: 'merged' } | { readonly kind: 'failed'; readonly reason: string }> {
      const inspection = await settings.git.inspectRepository(worktree);
      if (!inspection.ok) {
        return { kind: 'failed', reason: inspection.fault.message };
      }
      const branch = inspection.value.branch;
      if (branch === null) {
        return { kind: 'failed', reason: 'The architecture worktree has no branch to publish.' };
      }
      const committed =
        inspection.value.trackedChanges || inspection.value.untrackedChanges
          ? await settings.git.commitAll(
              worktree,
              `Publish architecture documents for ${selection.taskKey}`,
            )
          : { ok: true as const, value: { branch, headRevision: inspection.value.headRevision } };
      if (!committed.ok) {
        return { kind: 'failed', reason: committed.fault.message };
      }
      const head = committed.value.headRevision;
      if (head === null) {
        return { kind: 'failed', reason: 'The architecture worktree has no revision to publish.' };
      }
      const pushed = await settings.git.pushBranch(worktree, branch, head);
      if (!pushed.ok) {
        return { kind: 'failed', reason: pushed.fault.message };
      }
      const repository = settings.repository;
      const found = await settings.github.findPullRequests(repository, {
        branch,
        baseBranch: settings.baseBranch,
      });
      if (!found.ok) {
        return { kind: 'failed', reason: found.fault.message };
      }
      let pullRequestNumber = found.value[0]?.number ?? null;
      if (pullRequestNumber === null) {
        const created = await settings.github.createPullRequest(repository, {
          baseBranch: settings.baseBranch,
          headBranch: branch,
          title: `${selection.taskKey}: architecture documents`,
          body: [
            `Authoritative documents for ${selection.taskKey}.`,
            '',
            ...documents.map((document) => `- ${path.relative(worktree, document)}`),
          ].join('\n'),
        });
        if (!created.ok) {
          return { kind: 'failed', reason: created.fault.message };
        }
        pullRequestNumber = created.value.number;
      }
      const observation = await confirmMerged(repository, pullRequestNumber);
      if (observation.kind === 'failed') {
        return observation;
      }
      handoff.publications = [
        ...handoff.publications.filter((publication) => publication.kind !== 'documentation-pr'),
        { kind: 'documentation-pr', id: observation.pullRequest.url },
      ];
      await writeHandoff(selection.workspace.root, handoff);
      return { kind: 'merged' };
    }

    /** Poll the documentation pull request until it merges with its required checks passing. */
    async function confirmMerged(
      repository: string,
      pullRequestNumber: number,
    ): Promise<
      | { readonly kind: 'merged'; readonly pullRequest: PullRequest }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      const deadline = Date.now() + settings.completion.waitLimitSeconds * 1000;
      for (;;) {
        const observed = await settings.github.readPullRequest(repository, pullRequestNumber);
        if (!observed.ok) {
          return { kind: 'failed', reason: observed.fault.message };
        }
        if (observed.value.state === 'closed' && !observed.value.merged) {
          return {
            kind: 'failed',
            reason: `The documentation pull request #${String(pullRequestNumber)} closed without merging.`,
          };
        }
        if (observed.value.merged) {
          const checks = await settings.github.readRequiredChecks(repository, pullRequestNumber);
          if (!checks.ok) {
            return { kind: 'failed', reason: checks.fault.message };
          }
          const failed = checks.value.checks.filter(
            (check) => check.conclusion !== null && check.conclusion !== 'success',
          );
          if (failed.length > 0) {
            return {
              kind: 'failed',
              reason:
                `The documentation pull request #${String(pullRequestNumber)} merged with failed ` +
                `required checks: ${failed.map((check) => check.name).join(', ')}.`,
            };
          }
          const pending = checks.value.checks.filter((check) => check.conclusion === null);
          if (pending.length === 0) {
            return { kind: 'merged', pullRequest: observed.value };
          }
          if (Date.now() >= deadline) {
            return {
              kind: 'failed',
              reason:
                `The documentation pull request #${String(pullRequestNumber)} merged while required ` +
                `checks remained pending past ${String(settings.completion.waitLimitSeconds)} seconds.`,
            };
          }
          await settings.wait(Math.max(1, settings.completion.pollIntervalSeconds) * 1000);
          continue;
        }
        if (Date.now() >= deadline) {
          return {
            kind: 'failed',
            reason:
              `The documentation pull request #${String(pullRequestNumber)} did not merge within ` +
              `${String(settings.completion.waitLimitSeconds)} seconds.`,
          };
        }
        await settings.wait(Math.max(1, settings.completion.pollIntervalSeconds) * 1000);
      }
    }
  };
}
