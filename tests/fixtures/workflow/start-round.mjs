/**
 * A controlled workflow module for the worker composition test: its only operation is StartRound,
 * so the worker constructs every component but needs no external service or agent.
 */

import { createMachine } from 'xstate';

export const successfulOutcomes = ['started'];

export default createMachine(
  {
    id: 'start-round',
    initial: 'start',
    output: ({ event }) => event.output,
    states: {
      start: {
        invoke: {
          src: 'StartRound',
          onDone: [
            { guard: ({ event }) => event.output === 'started', target: 'finished' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      finished: { type: 'final', output: 'started' },
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
