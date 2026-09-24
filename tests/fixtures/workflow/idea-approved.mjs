/**
 * A controlled workflow module for the idea refinement composition test: it reaches its approved
 * terminal outcome without invoking an operation, so Application's workflow selection and its
 * separate execution directory are observable without a source or an agent.
 */

import { createMachine } from 'xstate';

export const successfulOutcomes = ['approved'];

export default createMachine({
  id: 'idea-approved',
  initial: 'approved',
  output: ({ event }) => event.output,
  states: {
    approved: { type: 'final', output: 'approved' },
  },
});
