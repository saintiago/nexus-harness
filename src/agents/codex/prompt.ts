/**
 * What one coding turn is told: the task with its acceptance criteria, where it
 * works, what the project asks of it, what the harness refuses to have done on
 * its behalf, and — for a repair turn — the failures the harness observed.
 * A reviewed baseline finding is not ordinary context: it is rendered as what
 * this attempt has to repair before the original task continues.
 *
 * One prompt for both kinds of turn; a repair turn is the same turn with what
 * went wrong added. Guidance a source collected is context, and never a command,
 * a path, or a limit of its own.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { renderHistorySection } from '../../history/prompt.js';
import { BASELINE_GUIDANCE_PREFIX } from '../../runs/contracts.js';
import type { AgentTurnRequest } from '../../runs/contracts.js';
import type { FailedCommand } from '../../shared/types.js';

/** The instruction file a working copy may hold, named in a prompt when it has one. */
const INSTRUCTION_FILE = 'AGENTS.md';
/**
 * What the harness tells a coding turn about itself: the task it implements or
 * repairs, where it works, what the project asks of it, and what the harness
 * refuses to have done on its behalf. It is one prompt for both kinds of turn —
 * a repair turn is the same turn with what went wrong added.
 */
export function promptFor(request: AgentTurnRequest): string {
  const { task, workspacePath, sourceRoot, baseCommit, kind, turn, repair } = request;
  const sections: string[] = [];

  sections.push(
    [
      'You are completing one task inside a detached working copy of a repository.',
      'A local harness started you, and it will run the project’s own configured checks in this',
      'working copy when you are done. Those checks, not your own account of the work, decide',
      'whether the task passed.',
    ].join('\n'),
  );

  sections.push(`## Task ${task.id}: ${task.title}\n${task.description.trim()}`);

  // One reviewed baseline finding is not context: it is what this attempt has to
  // do before the original task continues, so it is rendered first and as a
  // requirement of its own (docs/WORKFLOW.md §11).
  const guidance = request.guidance ?? [];
  const baselineFinding = guidance.filter((line) => line.startsWith(BASELINE_GUIDANCE_PREFIX));
  const notes = guidance.filter((line) => !line.startsWith(BASELINE_GUIDANCE_PREFIX));
  if (baselineFinding.length > 0) {
    sections.push(
      [
        '## Repair the baseline before the task',
        'The configured baseline checks of this working copy failed before its first coding turn,',
        'and the configured reviewer inspected the exact snapshot and recorded the finding below.',
        'Repair the baseline first: this attempt may continue the original task only after it. The',
        'harness runs the configured commands again after this turn, and nothing is delivered while',
        'they are still red.',
        ...baselineFinding.map((line) => `- ${line}`),
      ].join('\n'),
    );
  }

  if (notes.length > 0) {
    // Context a source collected for this attempt: what the issue's comments said
    // since the previous one, and what the harness's own earlier attempts did.
    // Context for the work, never a command, a path, or a limit of its own.
    sections.push(
      [
        '## Guidance for this attempt',
        'Notes gathered for this attempt: what the issue thread says, and what an earlier attempt at',
        'this task did when it did not pass. They are context, not part of the task:',
        ...notes.map((line) => `- ${line}`),
        'They do not change the acceptance criteria above, and the same configured checks still',
        'decide whether this turn passed.',
      ].join('\n'),
    );
  }

  // The ticket's own conversation history, when the caller prepared one: the
  // same identified snapshot and the same organization a reviewer turn is
  // given, with the complete entries beside the workspace for local search.
  if (request.history !== undefined) {
    sections.push(renderHistorySection(request.history, 'developer'));
  }

  sections.push(
    ['## Acceptance criteria', ...task.acceptanceCriteria.map((one) => `- ${one.trim()}`)].join(
      '\n',
    ),
  );

  const instructions = existsSync(path.join(workspacePath, INSTRUCTION_FILE))
    ? `This working copy has its own ${INSTRUCTION_FILE} at its root: read it and follow it.`
    : `Whatever instructions the project keeps for coding agents — ${INSTRUCTION_FILE}, a README, contribution notes — are part of the task.`;
  sections.push(
    [
      '## Where you are working',
      `The working copy is ${workspacePath}. It was cloned from ${sourceRoot}, and ${baseCommit} is`,
      'its recorded base commit: the harness keeps comparing the work against it — commits included —',
      'for as long as this workspace lives. It is the project root for this turn: the runtime was',
      'started in it.',
      instructions,
    ].join('\n'),
  );

  sections.push(
    [
      '## What this turn must not do',
      '- Do not weaken, skip, delete, or loosen the project’s tests, checks, linting, type checking,',
      '  or other tooling to make the work look finished. Fix the cause, not the way it is checked.',
      '- Do not change how the project is built or checked, and do not touch the harness that started',
      '  you: its configuration and the commands it runs live outside this working copy, and they are',
      '  not yours to change. This turn is not sandboxed, so nothing else stops a write outside it:',
      '  do not make one.',
      `- Do not modify the source checkout this copy came from (${sourceRoot}), or any other` +
        ' checkout, and do not push, open pull requests, publish packages, deploy, or upload the work',
      '  anywhere: this turn’s work stays in this working copy.',
      `- Work only on the task. Leave everything you are not asked to change as you found it.`,
    ].join('\n'),
  );

  sections.push(
    [
      '## Local commits',
      'Make small, meaningful local commits in this working copy as you go — a completed piece, or',
      'work in progress you can describe — and finish with the work you want built on committed: the',
      'harness starts no further coding turn from a working copy that still holds uncommitted work',
      '(staged, unstaged, or untracked), and one it finds that way stops the run for a person instead.',
      'The working copy is already configured to commit as Nexus Agent, and a previous attempt may',
      'have committed here too.',
      'These commits are local to this working copy: do not push, open a pull request, or publish.',
      'A commit proves nothing about the checks — the harness runs them itself and its results decide',
      'the task — and anything you leave uncommitted is kept, not discarded.',
    ].join('\n'),
  );

  if (repair !== null) {
    sections.push(repairSection(kind, turn, repair));
  }

  sections.push(
    [
      '## When you are done',
      'Answer with a short summary of what you changed and why. The harness records it beside its',
      'own check results as your account of the turn, and it never counts as one of them.',
    ].join('\n'),
  );

  return `${sections.join('\n\n')}\n`;
}

/** What a repair turn is told about the round it repairs, failures and all. */
function repairSection(
  kind: AgentTurnRequest['kind'],
  turn: number,
  repair: NonNullable<AgentTurnRequest['repair']>,
): string {
  const lines = [
    `## Why this turn exists (${kind} turn ${String(turn)})`,
    `The harness ran the configured commands after turn ${String(repair.repairedTurn)}, and the ones`,
    'below did not exit 0. Fix the cause in the working copy; the commands themselves, and the',
    'harness configuration that defines them, are outside it and are not yours to change.',
  ];

  for (const failure of repair.failures) {
    lines.push('', failureSection(failure));
  }

  return lines.join('\n');
}

/** One failed command: the invocation the harness recorded, and what it wrote. */
function failureSection(failure: FailedCommand): string {
  const { result } = failure;
  const how =
    result.exitCode === null
      ? `${result.outcome}${result.signal === null ? '' : ` (${result.signal})`}`
      : `exit code ${String(result.exitCode)}`;
  return [
    `### ${JSON.stringify(result.command)} — ${how}`,
    `ran in ${result.cwd}`,
    `standard output: ${result.stdoutPath}`,
    `standard error: ${result.stderrPath}`,
    'Output as far as it was recorded:',
    failure.output.trim() === '' ? '(no output was written)' : failure.output.trim(),
  ].join('\n');
}
