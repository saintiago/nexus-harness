import { createMachine } from 'xstate';

/**
 * The project parent: it selects one eligible issue in source rank order, invokes the child
 * appropriate to the issue's stage and owns every Jira read, publication and transition. Children
 * are invoked machine actors; they receive captured source data and return their business
 * decision. The parent publishes preparation results, advances or returns upstream, creates the
 * linked implementation tickets after an Architecture handoff and completes delivery work only
 * after the child's merge/check evidence. Bind Nexus operations as promise actors and the child
 * definitions as machine actors with machine.provide({ actors }) before execution.
 */

export const project = createMachine(
  {
    id: 'project',
    initial: 'select',
    output: ({ event }) => event.output,
    states: {
      select: {
        invoke: {
          src: 'SelectWork',
          onDone: [
            { guard: ({ event }) => event.output === 'selected', target: 'route' },
            { guard: ({ event }) => event.output === 'empty', target: 'drained' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The saved selection's stage decides which child runs; a missing mapping requests attention.
      route: {
        invoke: {
          src: 'RouteSelection',
          onDone: [
            { guard: ({ event }) => event.output === 'idea', target: 'idea' },
            { guard: ({ event }) => event.output === 'requirements', target: 'requirements' },
            { guard: ({ event }) => event.output === 'ux', target: 'ux' },
            { guard: ({ event }) => event.output === 'prototype', target: 'prototype' },
            { guard: ({ event }) => event.output === 'architecture', target: 'architecture' },
            { guard: ({ event }) => event.output === 'delivery', target: 'delivery' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      idea: {
        invoke: {
          src: 'IdeaRefinement',
          onDone: [
            { guard: ({ event }) => event.output === 'approved', target: 'publishIdeaApproved' },
            {
              guard: ({ event }) => event.output === 'unsuitable',
              target: 'publishIdeaUnsuitable',
            },
            {
              guard: ({ event }) => event.output === 'author-decision-needed',
              target: 'publishIdeaAuthorDecision',
            },
            {
              guard: ({ event }) => event.output === 'attempts-exhausted',
              target: 'publishIdeaAttemptsExhausted',
            },
            { guard: ({ event }) => event.output === 'blocked', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The parent publishes each idea decision and preserves its destination through learning.
      publishIdeaApproved: {
        invoke: {
          src: 'PublishIdeaResult',
          input: { decision: 'approved' },
          onDone: [
            { guard: ({ event }) => event.output === 'approved', target: 'analyzeIdeaApproved' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      publishIdeaUnsuitable: {
        invoke: {
          src: 'PublishIdeaResult',
          input: { decision: 'unsuitable' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'analyzeIdeaFeedback',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      publishIdeaAuthorDecision: {
        invoke: {
          src: 'PublishIdeaResult',
          input: { decision: 'author-decision-needed' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'analyzeIdeaFeedback',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      publishIdeaAttemptsExhausted: {
        invoke: {
          src: 'PublishIdeaResult',
          input: { decision: 'attempts-exhausted' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'analyzeIdeaFeedback',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeIdeaApproved: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'idea-approved' },
          onDone: [
            { guard: preservesDestination, target: 'select' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeIdeaFeedback: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'idea-feedback' },
          onDone: [
            { guard: preservesDestination, target: 'select' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      requirements: {
        invoke: {
          src: 'Preparation',
          input: { stage: 'requirements' },
          onDone: [
            { guard: ({ event }) => event.output === 'blocked', target: 'blocked' },
            { target: 'publishRequirements' },
          ],
        },
      },
      publishRequirements: {
        invoke: {
          src: 'PublishPreparationResult',
          input: { stage: 'requirements' },
          onDone: [
            { guard: ({ event }) => event.output === 'advanced', target: 'route' },
            { guard: ({ event }) => event.output === 'waiting', target: 'select' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      ux: {
        invoke: {
          src: 'Preparation',
          input: { stage: 'ux' },
          onDone: [
            { guard: ({ event }) => event.output === 'blocked', target: 'blocked' },
            { target: 'publishUx' },
          ],
        },
      },
      publishUx: {
        invoke: {
          src: 'PublishPreparationResult',
          input: { stage: 'ux' },
          onDone: [
            { guard: ({ event }) => event.output === 'advanced', target: 'route' },
            { guard: ({ event }) => event.output === 'waiting', target: 'select' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      prototype: {
        invoke: {
          src: 'Preparation',
          input: { stage: 'prototype' },
          onDone: [
            { guard: ({ event }) => event.output === 'blocked', target: 'blocked' },
            { target: 'publishPrototype' },
          ],
        },
      },
      publishPrototype: {
        invoke: {
          src: 'PublishPreparationResult',
          input: { stage: 'prototype' },
          onDone: [
            { guard: ({ event }) => event.output === 'advanced', target: 'route' },
            { guard: ({ event }) => event.output === 'waiting', target: 'select' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      architecture: {
        invoke: {
          src: 'Preparation',
          input: { stage: 'architecture' },
          onDone: [
            { guard: ({ event }) => event.output === 'blocked', target: 'blocked' },
            { target: 'publishArchitecture' },
          ],
        },
      },
      publishArchitecture: {
        invoke: {
          src: 'PublishPreparationResult',
          input: { stage: 'architecture' },
          onDone: [
            { guard: ({ event }) => event.output === 'handoff', target: 'handoff' },
            { guard: ({ event }) => event.output === 'advanced', target: 'route' },
            { guard: ({ event }) => event.output === 'waiting', target: 'select' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // Architecture hands off linked implementation tickets before the original closes.
      handoff: {
        invoke: {
          src: 'HandoffImplementation',
          onDone: [
            { guard: ({ event }) => event.output === 'handed-off', target: 'select' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      delivery: {
        invoke: {
          src: 'FiniteDelivery',
          onDone: [
            { guard: ({ event }) => event.output === 'completed', target: 'completeDelivery' },
            { guard: ({ event }) => event.output === 'blocked', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The parent marks the ticket Done only after the child's merge/check evidence.
      completeDelivery: {
        invoke: {
          src: 'CompleteDelivery',
          onDone: [
            { guard: ({ event }) => event.output === 'completed', target: 'select' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      drained: { type: 'final', output: 'drained' },
      blocked: { type: 'final', output: 'blocked' },
    },
  },
  {
    actions: {
      unexpectedOutcome: ({ event }) => {
        throw new Error(`Unexpected action outcome: ${String(event.output)}`);
      },
    },
  },
);

/**
 * AnalyzeExperience's capture outcomes; all three preserve the parent's business destination, so
 * a skipped or unavailable capture never changes which selection runs next.
 */
const experienceOutcomes: readonly string[] = ['recorded', 'skipped', 'unavailable'];

/** Whether one AnalyzeExperience outcome preserves the original destination. */
function preservesDestination({
  event,
}: {
  readonly event: { readonly output: unknown };
}): boolean {
  return typeof event.output === 'string' && experienceOutcomes.includes(event.output);
}

/** The drained queue completes successfully; blocked needs recovery. */
export const successfulOutcomes: readonly string[] = ['drained'];

export default project;
