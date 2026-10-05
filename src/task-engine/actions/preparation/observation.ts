import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../adapters/git.js';
import { messageOf } from '../../../result.js';
import { describeIssues, parseDocument, readDocumentText } from '../documents.js';
import { assessedContentSchema, type AssessedContent } from './artifacts.js';
import { checkoutRelative, requireEvaluationContent } from './evaluation-content.js';
import { renderedImageProblem } from './rendered-image.js';

/**
 * The prototype roles' observation contract: one producer-owned record each role saves under its
 * round artifact area and references from its report. The record binds what the role inspected to
 * the evaluated prototype revision; the stage actions validate it before any acceptance relies on
 * it. An image path or a claimed successful build alone is never sufficient evidence.
 */

/** One saved prototype observation record, as both prototype roles declare it. */
export const prototypeObservationSchema = z.strictObject({
  /** Which prototype role performed the observation; it must match the declaring report. */
  role: z
    .enum(['author', 'evaluator'])
    .describe('The role that performed the observation; it must match the declaring report.'),
  /** The inspected prototype content, bound to the revision the role observed it at. */
  content: z
    .array(assessedContentSchema)
    .min(1)
    .describe('The inspected prototype content bound to the revision it was observed at.'),
  /** The preview the role actually used: the exact start command and the URL it reached. */
  preview: z
    .strictObject({
      command: z.string().trim().min(1).describe('The exact preview start command used.'),
      url: z.string().trim().min(1).describe('The URL the preview reached.'),
    })
    .describe('The preview the role actually used.'),
  /** One exercised journey or state with its actions, result and rendered-image evidence. */
  journeys: z
    .array(
      z.strictObject({
        example: z.string().trim().min(1).describe('The acceptance example or journey exercised.'),
        state: z.string().trim().min(1).describe('The state the prototype was in.'),
        actions: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe('The actions the role performed, in order.'),
        observed: z.string().trim().min(1).describe('What the prototype did in response.'),
        screenshots: z
          .array(
            z.strictObject({
              path: z
                .string()
                .trim()
                .min(1)
                .describe('The saved rendered image under the round artifact area.'),
            }),
          )
          .min(1)
          .describe('The rendered-image evidence a reader can open, saved under the round area.'),
        visualConclusion: z.string().trim().min(1).describe('What the rendered images show.'),
      }),
    )
    .min(1)
    .describe('The journeys or states actually exercised and observed.'),
});

export type PrototypeObservation = z.infer<typeof prototypeObservationSchema>;

/** The role one prototype observation record must state. */
export type PrototypeObservationRole = PrototypeObservation['role'];

/**
 * The observation contract the prototype roles receive with their invocation context: the runtime
 * schema they write their record against and how the evidence is retained and bound.
 */
export function prototypeObservationContract(roundDirectory: string): string {
  return [
    'Prototype observation contract (save your own record under the round artifact area and',
    'return its path as the response field "observation"):',
    JSON.stringify(z.toJSONSchema(prototypeObservationSchema), null, 2),
    `Round artifact area: ${roundDirectory}`,
    '- Start the project\u2019s Storybook preview from the shared checkout with the project\u2019s own',
    '  command, in your own browser session, and release the preview and browser processes after',
    '  the observation.',
    '- Commit the stage-owned prototype paths you inspected first, then name that commit revision',
    '  in every content entry; content at the named revision must still match the evaluated',
    '  revision, so edit, commit and observe in that order.',
    '- Save your screenshots under the round artifact area; each journey needs rendered-image',
    '  evidence a reader can open, not a build log or an image path alone.',
    '- Record the preview start command and URL you used, and the actions you performed.',
    '- A skip carries no observation. Applicable work you accept needs your own observation; a',
    '  change request or upstream return keeps the observation of the preview you performed, so the',
    '  defect evidence reaches the repair handoff.',
  ].join('\n');
}

/**
 * One declared evidence path resolved inside its round artifact area, or null when it lies outside
 * it. A relative path resolves against the round artifact area; an absolute path must already name
 * a file inside it.
 */
export function evidenceFilePath(roundDirectory: string, declared: string): string | null {
  const resolved = path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(roundDirectory, declared);
  const relative = path.relative(roundDirectory, resolved);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
    ? null
    : resolved;
}

/**
 * Read one role's saved prototype observation record and validate everything the producer-owned
 * contract can check without judging usability: the record lies inside the role's round artifact
 * area, matches the observation schema, states the declaring role and references readable
 * rendered-image screenshots from that same area. Throws a concrete reason otherwise.
 */
export async function readPrototypeObservation(settings: {
  readonly declared: string;
  readonly roundDirectory: string;
  readonly role: PrototypeObservationRole;
}): Promise<PrototypeObservation> {
  const file = evidenceFilePath(settings.roundDirectory, settings.declared);
  if (file === null) {
    throw new Error(
      `The ${settings.role}'s prototype observation "${settings.declared}" lies outside the ` +
        `round artifact area "${settings.roundDirectory}".`,
    );
  }
  const text = await readDocumentText(file, `${settings.role} prototype observation`);
  if (text === null) {
    throw new Error(`The ${settings.role}'s prototype observation "${file}" does not exist.`);
  }
  const parsed = parseDocument(text, prototypeObservationSchema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(
      `The ${settings.role}'s prototype observation "${file}" is not valid JSON: ` +
        `${messageOf(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `The ${settings.role}'s prototype observation "${file}" does not match the observation ` +
        `contract: ${describeIssues(parsed.error, '<observation>')}`,
      { cause: parsed.error },
    );
  }
  const observation = parsed.content;
  if (observation.role !== settings.role) {
    throw new Error(
      `The prototype observation "${file}" records the ${observation.role} role while the ` +
        `${settings.role} declared it.`,
    );
  }
  for (const journey of observation.journeys) {
    for (const screenshot of journey.screenshots) {
      const image = evidenceFilePath(settings.roundDirectory, screenshot.path);
      if (image === null) {
        throw new Error(
          `The screenshot "${screenshot.path}" of journey "${journey.example}" lies outside the ` +
            `round artifact area "${settings.roundDirectory}".`,
        );
      }
      let bytes: Buffer;
      try {
        const entry = await stat(image);
        if (!entry.isFile()) {
          throw new Error('not a regular file');
        }
        bytes = await readFile(image);
      } catch (error) {
        throw new Error(
          `The screenshot "${image}" of journey "${journey.example}" is not readable: ` +
            messageOf(error),
          { cause: error },
        );
      }
      const problem = await renderedImageProblem(bytes);
      if (problem !== null) {
        throw new Error(
          `The screenshot "${image}" of journey "${journey.example}" is not readable rendered ` +
            `image evidence: ${problem}.`,
        );
      }
    }
  }
  return observation;
}

/**
 * Why one committed deletion an observation binds is inconsistent with the shared checkout's
 * history, or null: the named revision must be a commit on the retained branch whose parent
 * still tracked the path. This checks the content binding, not stage ownership; StageAuthor
 * establishes ownership independently from pre-invocation tracking or retained stage records.
 */
async function deletionBindingProblem(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly revision: string;
  readonly relative: string;
}): Promise<string | null> {
  const inspection = await settings.git.inspectRepository(settings.worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  const head = inspection.value.headRevision;
  if (head === null) {
    return 'the shared checkout has no revision to attribute the deletion to';
  }
  const ancestor = await settings.git.readMergeBase(settings.worktree, settings.revision, head);
  if (!ancestor.ok || ancestor.value !== settings.revision) {
    return (
      `the observation binds the deletion to revision ${settings.revision}, which is not part of ` +
      'the submitted revision history'
    );
  }
  const before = await settings.git.readFileAtRevision(
    settings.worktree,
    `${settings.revision}^`,
    settings.relative,
  );
  return before.ok
    ? null
    : `"${settings.relative}" was not tracked before revision ${settings.revision}`;
}

/**
 * Why the observation does not bind the content the author is submitting, or null when it does:
 * every entry's named revision must retain exactly the content the shared checkout holds now, so
 * the author commits the inspected prototype before observing it. A later edit without fresh
 * observation is rejected instead of silently accepted.
 */
export async function observationSubmissionProblem(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly observation: PrototypeObservation;
}): Promise<string | null> {
  const { git, worktree, observation } = settings;
  for (const entry of observation.content) {
    const relative = checkoutRelative(worktree, entry.path);
    if (relative === null) {
      return `the observation names "${entry.path}", which lies outside the shared preparation checkout`;
    }
    const saved = await git.readFileAtRevision(worktree, entry.revision, relative);
    if (!entry.exists) {
      if (saved.ok) {
        return (
          `the observation reports "${relative}" as deleted while revision ${entry.revision} ` +
          'retains it'
        );
      }
      const deletion = await deletionBindingProblem({
        git,
        worktree,
        revision: entry.revision,
        relative,
      });
      if (deletion !== null) {
        return deletion;
      }
      continue;
    }
    if (!saved.ok) {
      return (
        `the observation names revision ${entry.revision}, which does not retain "${relative}"; ` +
        'commit the inspected content and bind that revision'
      );
    }
    let current: string;
    try {
      const entry = await stat(path.join(worktree, relative));
      if (!entry.isFile()) {
        return `the observation names "${relative}", which is not a file in the shared checkout`;
      }
      current = await readFile(path.join(worktree, relative), 'utf8');
    } catch (error) {
      throw new Error(`The observed path "${relative}" could not be read: ${messageOf(error)}`, {
        cause: error,
      });
    }
    if (saved.value !== current) {
      return (
        `the observation of "${relative}" at revision ${entry.revision} differs from the ` +
        'content being submitted; commit the inspected content and bind that revision'
      );
    }
  }
  return null;
}

/**
 * Why the observation's own content does not name usable repository content, or null when it does:
 * every entry must be a unique path inside the shared checkout, and the observation must cover
 * every stage-owned prototype path the author declared.
 */
export function observationScopeProblem(settings: {
  readonly worktree: string;
  readonly observation: PrototypeObservation;
  /** The stage-owned prototype paths the observation must cover, as the author declared them. */
  readonly observedPaths: readonly string[];
}): string | null {
  const { worktree, observation } = settings;
  const observed = new Set<string>();
  for (const entry of observation.content) {
    const relative = checkoutRelative(worktree, entry.path);
    if (relative === null) {
      return `the observation names "${entry.path}", which lies outside the shared preparation checkout`;
    }
    if (observed.has(relative)) {
      return `the observation names "${relative}" more than once`;
    }
    observed.add(relative);
  }
  for (const value of settings.observedPaths) {
    const relative = checkoutRelative(worktree, value);
    if (relative === null || !observed.has(relative)) {
      return `the observation does not cover the stage-owned prototype path "${value}"`;
    }
  }
  return null;
}

/**
 * Why one role's observation does not match the evaluated prototype content, or null when it does.
 * Every observed entry must name content this evaluation assessed and carry the same bytes at the
 * observation's revision, and the observation must cover every stage-owned prototype path. A
 * changed prototype therefore cannot reuse an earlier observation.
 */
export async function observationContentProblem(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly observation: PrototypeObservation;
  readonly assessed: readonly AssessedContent[];
  /** The stage-owned prototype paths the observation must cover, as the author declared them. */
  readonly observedPaths: readonly string[];
}): Promise<string | null> {
  const { git, worktree, observation } = settings;
  const scope = observationScopeProblem(settings);
  if (scope !== null) {
    return scope;
  }
  const assessedByPath = new Map(settings.assessed.map((entry) => [entry.path, entry]));
  for (const entry of observation.content) {
    const relative = checkoutRelative(worktree, entry.path) as string;
    const binding = assessedByPath.get(relative);
    if (binding === undefined) {
      return `the observation names "${relative}", which this evaluation did not assess`;
    }
    if (binding.exists !== entry.exists) {
      return (
        `the observation reports "${relative}" as ` +
        `${entry.exists ? 'present' : 'absent'} while the evaluation assessed it as ` +
        `${binding.exists ? 'present' : 'absent'}`
      );
    }
    const observedContent = await git.readFileAtRevision(worktree, entry.revision, relative);
    const assessedContent = await git.readFileAtRevision(worktree, binding.revision, relative);
    if (!entry.exists) {
      if (observedContent.ok || assessedContent.ok) {
        return `the observation reports "${relative}" as deleted while a named revision retains it`;
      }
      const deletion = await deletionBindingProblem({
        git,
        worktree,
        revision: entry.revision,
        relative,
      });
      if (deletion !== null) {
        return deletion;
      }
      continue;
    }
    if (!observedContent.ok) {
      return (
        `the observation of "${relative}" names revision ${entry.revision}, which does not ` +
        'retain that file'
      );
    }
    if (!assessedContent.ok) {
      return `the evaluated revision ${binding.revision} does not retain "${relative}"`;
    }
    if (observedContent.value !== assessedContent.value) {
      return (
        `the observation of "${relative}" at revision ${entry.revision} differs from the ` +
        `evaluated revision ${binding.revision}; changed prototype content needs fresh observation`
      );
    }
  }
  return null;
}

/** One saved prototype observation record a stage result retains: its role and saved path. */
export type RetainedPrototypeObservation = {
  readonly role: PrototypeObservationRole;
  readonly path: string;
};

/** The round artifact directory one absolute retained evidence path lives under, or null. */
function retainedRoundDirectory(artifactsRoot: string, file: string): string | null {
  const relative = path.relative(artifactsRoot, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  const [round] = relative.split(path.sep);
  return round === undefined ? null : path.join(artifactsRoot, round);
}

/**
 * Why one retained observation record no longer authorizes the acceptance it was saved for, or
 * null when it still does: the record and its screenshots must remain readable inside the stage's
 * artifact area and bind the assessed content it was accepted with. A record deleted or edited
 * after the fact invalidates the decision instead of silently authorizing reuse.
 */
export async function retainedObservationProblem(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  /** The stage's artifacts root; a retained record stays inside one of its round directories. */
  readonly artifactsRoot: string;
  readonly observation: RetainedPrototypeObservation;
  readonly assessed: readonly AssessedContent[];
  readonly observedPaths: readonly string[];
}): Promise<string | null> {
  const { observation } = settings;
  const roundDirectory = retainedRoundDirectory(settings.artifactsRoot, observation.path);
  if (roundDirectory === null) {
    return (
      `the retained ${observation.role} observation "${observation.path}" lies outside the ` +
      `stage's artifact area "${settings.artifactsRoot}"`
    );
  }
  let saved: PrototypeObservation;
  try {
    saved = await readPrototypeObservation({
      declared: observation.path,
      roundDirectory,
      role: observation.role,
    });
  } catch (error) {
    return messageOf(error);
  }
  const problem = await observationContentProblem({
    git: settings.git,
    worktree: settings.worktree,
    observation: saved,
    assessed: settings.assessed,
    observedPaths: settings.observedPaths,
  });
  if (problem !== null) {
    return problem;
  }
  // Every inspected path remains bound to the current preview, including rendered documents.
  // Documents outside the observation can still change in a later preparation stage.
  const inspected = new Set(
    saved.content.map((entry) => checkoutRelative(settings.worktree, entry.path)),
  );
  try {
    await requireEvaluationContent({
      git: settings.git,
      worktree: settings.worktree,
      content: settings.assessed.filter((entry) => inspected.has(entry.path)),
    });
  } catch (error) {
    return messageOf(error);
  }
  return null;
}

/**
 * Require an applicable prototype acceptance's retained evidence: both roles' observation records
 * must still be present, readable and bound to the evaluated content. A missing or unusable
 * record cannot keep authorizing resumed acceptance, reuse or downstream decisions.
 */
export async function requireRetainedPrototypeEvidence(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly artifactsRoot: string;
  readonly observations: readonly RetainedPrototypeObservation[];
  readonly assessed: readonly AssessedContent[];
  readonly observedPaths: readonly string[];
}): Promise<void> {
  const roles = new Set(settings.observations.map((observation) => observation.role));
  if (!roles.has('author') || !roles.has('evaluator')) {
    throw new Error(
      'The retained prototype acceptance is missing one role\u2019s saved observation record.',
    );
  }
  for (const observation of settings.observations) {
    const problem = await retainedObservationProblem({ ...settings, observation });
    if (problem !== null) {
      throw new Error(
        `The retained ${observation.role} prototype observation is unusable: ${problem}.`,
      );
    }
  }
}
