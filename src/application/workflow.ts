import { pathToFileURL } from 'node:url';
import type { AnyStateMachine } from 'xstate';
import type { NexusConfiguration } from '../configuration/index.js';
import { messageOf } from '../result.js';

/**
 * The configured workflow module: the XState definition finite execution runs and the terminal
 * outcomes that count as finishing successfully. Application reads the successful outcomes and the
 * worker reads the definition, so both are available before the first worker starts.
 */
export type Workflow = {
  readonly machine: AnyStateMachine;
  readonly successfulOutcomes: readonly string[];
};

/** True for the shape of an XState definition: it binds actors and exposes a root state. */
function isStateMachine(value: unknown): value is AnyStateMachine {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly provide?: unknown; readonly root?: unknown };
  return (
    typeof candidate.provide === 'function' &&
    typeof candidate.root === 'object' &&
    candidate.root !== null
  );
}

/** Load the configured workflow module and validate its definition and successful outcomes. */
export async function loadWorkflow(filePath: string): Promise<Workflow> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(filePath).href);
  } catch (error) {
    throw new Error(`Cannot load the configured workflow "${filePath}": ${messageOf(error)}`, {
      cause: error,
    });
  }
  const exported: Record<string, unknown> =
    typeof module === 'object' && module !== null ? (module as Record<string, unknown>) : {};

  const machine = exported['default'];
  if (!isStateMachine(machine)) {
    throw new Error(`The workflow module "${filePath}" must default-export its XState definition.`);
  }
  const outcomes = exported['successfulOutcomes'];
  if (
    !Array.isArray(outcomes) ||
    outcomes.length === 0 ||
    !outcomes.every((outcome) => typeof outcome === 'string' && outcome.trim() !== '')
  ) {
    throw new Error(
      `The workflow module "${filePath}" must export the nonempty successfulOutcomes list of ` +
        'terminal outcomes that complete successfully.',
    );
  }
  return { machine, successfulOutcomes: outcomes };
}

/** The composed project parent and the child machines its states invoke by name. */
export type ProjectWorkflow = Workflow & {
  readonly children: Readonly<Record<string, AnyStateMachine>>;
};

/** The actor name each configured child definition is registered under. */
const childActors: readonly {
  readonly name: string;
  readonly path: (workflow: NexusConfiguration['workflow']) => string;
}[] = [
  {
    name: 'IdeaRefinement',
    path: (workflow) => workflow.children['idea-refinement'],
  },
  {
    name: 'FiniteDelivery',
    path: (workflow) => workflow.children['finite-delivery'],
  },
  {
    name: 'Preparation',
    path: (workflow) => workflow.children.preparation,
  },
];

/** Load the project parent and register its configured children under their actor names. */
export async function loadProjectWorkflow(
  definitions: NexusConfiguration['workflow'],
): Promise<ProjectWorkflow> {
  const parent = await loadWorkflow(definitions.project);
  const children = Object.fromEntries(
    await Promise.all(
      childActors.map(async (child) => [
        child.name,
        (await loadWorkflow(child.path(definitions))).machine,
      ]),
    ),
  );
  return { ...parent, children };
}
