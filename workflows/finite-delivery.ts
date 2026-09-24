import { createMachine } from 'xstate';

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
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      startRound: {
        invoke: {
          src: 'StartRound',
          onDone: [
            { guard: ({ event }) => event.output === 'started', target: 'develop' },
            { guard: ({ event }) => event.output === 'exhausted', target: 'blocked' },
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
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
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
            { guard: ({ event }) => event.output === 'inconclusive', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      complete: {
        invoke: {
          src: 'CompleteTask',
          onDone: [
            { guard: ({ event }) => event.output === 'completed', target: 'select' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
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
