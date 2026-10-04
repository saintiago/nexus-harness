import { createMachine } from 'xstate';

/**
 * The terminal experience handoffs the child routes through the shared AnalyzeExperience action.
 * A handoff state returns the action's capture outcome (`recorded`, `skipped` or `unavailable`);
 * all three continue to the same original business destination, so analysis can never mask
 * success, convert failure to success, prevent the next item or replace recovery.
 */
const experienceOutcomes: readonly string[] = ['recorded', 'skipped', 'unavailable'];

/** Whether one AnalyzeExperience outcome preserves the original destination. */
const preservesDestination = ({ event }: { readonly event: { readonly output: unknown } }) =>
  typeof event.output === 'string' && experienceOutcomes.includes(event.output);

// Bind Nexus operations as promise actors with machine.provide({ actors }) before execution.
export const finiteDelivery = createMachine(
  {
    id: 'finite-delivery',
    initial: 'prepare',
    output: ({ event }) => event.output,
    states: {
      prepare: {
        invoke: {
          src: 'PrepareWorkspace',
          onDone: [
            { guard: ({ event }) => event.output === 'prepared', target: 'routeEntry' },
            { guard: ({ event }) => event.output === 'failed', target: 'analyzePrepareFailure' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      routeEntry: {
        invoke: {
          src: 'RouteDeliveryEntry',
          onDone: [
            { guard: ({ event }) => event.output === 'round', target: 'refreshRoundInput' },
            { guard: ({ event }) => event.output === 'verify', target: 'verify' },
            { guard: ({ event }) => event.output === 'deliver', target: 'deliver' },
            { guard: ({ event }) => event.output === 'review', target: 'publishDelivery' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The parent-owned input boundary refreshes the captured task and conversation before the
      // coding round reads them.
      refreshRoundInput: {
        invoke: {
          src: 'RefreshTaskInput',
          input: { boundary: 'round' },
          onDone: [
            { guard: ({ event }) => event.output === 'refreshed', target: 'startRound' },
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
            // A failed synthesis or verification is a repair turn: refresh the captured source
            // input before the next coding round reads it.
            { guard: ({ event }) => event.output === 'failed', target: 'refreshRoundInput' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      verify: {
        invoke: {
          src: 'Verify',
          onDone: [
            { guard: ({ event }) => event.output === 'passed', target: 'deliver' },
            { guard: ({ event }) => event.output === 'failed', target: 'refreshRoundInput' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      deliver: {
        invoke: {
          src: 'Deliver',
          onDone: [
            { guard: ({ event }) => event.output === 'published', target: 'publishDelivery' },
            { guard: ({ event }) => event.output === 'failed', target: 'analyzeDeliveryFailure' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The parent-owned publication actor sets the ticket's PR field/review status and publishes
      // the developer report before the child continues to review.
      publishDelivery: {
        invoke: {
          src: 'PublishDeliveryReport',
          onDone: [
            { guard: ({ event }) => event.output === 'published', target: 'refreshReviewInput' },
            { guard: ({ event }) => event.output === 'failed', target: 'analyzeDeliveryFailure' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // Reviewers read the task input refreshed at the review boundary.
      refreshReviewInput: {
        invoke: {
          src: 'RefreshTaskInput',
          input: { boundary: 'review' },
          onDone: [
            { guard: ({ event }) => event.output === 'refreshed', target: 'review' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      review: {
        invoke: {
          src: 'Review',
          onDone: [
            { guard: ({ event }) => event.output === 'approved', target: 'publishApprovedReview' },
            {
              guard: ({ event }) => event.output === 'changesRequested',
              target: 'publishChangesReview',
            },
            {
              guard: ({ event }) => event.output === 'inconclusive',
              target: 'analyzeInconclusive',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The parent-owned publication actor publishes the ticket feedback before completion or the
      // next repair round proceeds.
      publishApprovedReview: {
        invoke: {
          src: 'PublishReviewFeedback',
          onDone: [
            { guard: ({ event }) => event.output === 'published', target: 'complete' },
            {
              guard: ({ event }) => event.output === 'failed',
              target: 'analyzeReviewPublicationFailure',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      publishChangesReview: {
        invoke: {
          src: 'PublishReviewFeedback',
          onDone: [
            { guard: ({ event }) => event.output === 'published', target: 'refreshRoundInput' },
            {
              guard: ({ event }) => event.output === 'failed',
              target: 'analyzeReviewPublicationFailure',
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
            { guard: preservesDestination, target: 'completed' },
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
      analyzeReviewPublicationFailure: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'review-publication-failed' },
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
      // The child returns its completion evidence to the parent, which marks the ticket Done.
      completed: { type: 'final', output: 'completed' },
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

// The parent invokes this definition as a child actor. Its completed outcome carries the saved
// completion evidence to the parent; the blocked outcome stops the selected work for recovery.
export const successfulOutcomes: readonly string[] = ['completed'];

export default finiteDelivery;
