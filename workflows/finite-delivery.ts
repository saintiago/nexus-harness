import { createMachine } from 'xstate';

/**
 * The terminal experience handoffs every workflow routes through the shared AnalyzeExperience
 * action. A handoff state returns the action's capture outcome (`recorded`, `skipped` or
 * `unavailable`); all three continue to the same original business destination, so analysis can
 * never mask success, convert failure to success, prevent the next item or replace recovery.
 */
const experienceOutcomes: readonly string[] = ['recorded', 'skipped', 'unavailable'];

/** Whether one AnalyzeExperience outcome preserves the original destination. */
const preservesDestination = ({ event }: { readonly event: { readonly output: unknown } }) =>
  typeof event.output === 'string' && experienceOutcomes.includes(event.output);

// Bind Nexus operations as promise actors with machine.provide({ actors }) before execution.
export const finiteDelivery = createMachine(
  {
    id: 'finite-delivery',
    initial: 'select',
    output: ({ event }) => event.output,
    states: {
      select: {
        invoke: {
          src: 'SelectTask',
          onDone: [
            { guard: ({ event }) => event.output === 'selected', target: 'prepare' },
            { guard: ({ event }) => event.output === 'empty', target: 'finished' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      prepare: {
        invoke: {
          src: 'PrepareWorkspace',
          onDone: [
            { guard: ({ event }) => event.output === 'prepared', target: 'startRound' },
            { guard: ({ event }) => event.output === 'failed', target: 'analyzePrepareFailure' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      startRound: {
        invoke: {
          src: 'StartRound',
          onDone: [
            { guard: ({ event }) => event.output === 'started', target: 'develop' },
            { guard: ({ event }) => event.output === 'exhausted', target: 'analyzeExhaustion' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      develop: {
        invoke: {
          src: 'Develop',
          onDone: [
            { guard: ({ event }) => event.output === 'completed', target: 'verify' },
            { guard: ({ event }) => event.output === 'failed', target: 'startRound' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      verify: {
        invoke: {
          src: 'Verify',
          onDone: [
            { guard: ({ event }) => event.output === 'passed', target: 'deliver' },
            { guard: ({ event }) => event.output === 'failed', target: 'startRound' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      deliver: {
        invoke: {
          src: 'Deliver',
          onDone: [
            { guard: ({ event }) => event.output === 'published', target: 'review' },
            { guard: ({ event }) => event.output === 'failed', target: 'analyzeDeliveryFailure' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      review: {
        invoke: {
          src: 'Review',
          onDone: [
            { guard: ({ event }) => event.output === 'approved', target: 'complete' },
            { guard: ({ event }) => event.output === 'changesRequested', target: 'startRound' },
            {
              guard: ({ event }) => event.output === 'inconclusive',
              target: 'analyzeInconclusive',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      complete: {
        invoke: {
          src: 'CompleteTask',
          onDone: [
            { guard: ({ event }) => event.output === 'completed', target: 'analyzeCompletion' },
            { guard: ({ event }) => event.output === 'failed', target: 'analyzeCompletionFailure' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // One handoff state per terminal outcome: the same bound action serves them all, and each
      // preserves the destination the terminal previously reached. Selection failure and the
      // drained queue never enter one; repair rounds stay intermediate work.
      analyzeCompletion: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'complete-completed' },
          onDone: [
            { guard: preservesDestination, target: 'select' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzePrepareFailure: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'prepare-failed' },
          onDone: [
            { guard: preservesDestination, target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeExhaustion: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'start-round-exhausted' },
          onDone: [
            { guard: preservesDestination, target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeDeliveryFailure: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'deliver-failed' },
          onDone: [
            { guard: preservesDestination, target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeInconclusive: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'review-inconclusive' },
          onDone: [
            { guard: preservesDestination, target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeCompletionFailure: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'complete-failed' },
          onDone: [
            { guard: preservesDestination, target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      finished: { type: 'final', output: 'drained' },
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

// Application loads this module for both entry points: the default export is the workflow finite
// execution runs and successfulOutcomes names its successful terminal outcomes. The blocked
// outcome is not successful; it stops the execution.
export const successfulOutcomes: readonly string[] = ['drained'];

export default finiteDelivery;
