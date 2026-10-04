import { createMachine } from 'xstate';

/**
 * The evaluated preparation stage machine, invoked once per stage with the stage supplied as the
 * child's input. It prepares the stage worktree, opens a bounded round, has the author propose
 * work or a skip, has the evaluator assess that exact revision, routes the author's response to
 * the findings into the next round and returns the terminal result: accepted, skipped, an
 * upstream return, a retained question or exhaustion. Bind Nexus operations as promise actors with
 * machine.provide({ actors }) before execution.
 */

export const preparation = createMachine(
  {
    id: 'preparation',
    types: {} as {
      readonly input: { readonly stage: 'requirements' | 'ux' | 'prototype' | 'architecture' };
      readonly context: { readonly stage: 'requirements' | 'ux' | 'prototype' | 'architecture' };
    },
    context: ({ input }) => ({ stage: input.stage }),
    initial: 'prepare',
    output: ({ event }) => event.output,
    states: {
      prepare: {
        invoke: {
          src: 'PrepareStage',
          input: ({ context }) => ({ stage: context.stage }),
          onDone: [
            { guard: ({ event }) => event.output === 'prepared', target: 'startRound' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The first round has the author propose work or an evaluated skip.
      startRound: {
        invoke: {
          src: 'StartStageRound',
          input: ({ context }) => ({ stage: context.stage, route: 'new' }),
          onDone: [
            { guard: ({ event }) => event.output === 'opened', target: 'author' },
            { guard: ({ event }) => event.output === 'exhausted', target: 'finishExhausted' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      author: {
        invoke: {
          src: 'StageAuthor',
          input: ({ context }) => ({ stage: context.stage, task: 'propose' }),
          onDone: [
            { guard: ({ event }) => event.output === 'authored', target: 'evaluate' },
            { guard: ({ event }) => event.output === 'skip-proposed', target: 'evaluate' },
            { guard: ({ event }) => event.output === 'needs-input', target: 'finishNeedsInput' },
            { guard: ({ event }) => event.output === 'return-upstream', target: 'recordReturn' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      evaluate: {
        invoke: {
          src: 'StageEvaluator',
          input: ({ context }) => ({ stage: context.stage }),
          onDone: [
            { guard: ({ event }) => event.output === 'accepted', target: 'finishAccepted' },
            { guard: ({ event }) => event.output === 'accepted-skip', target: 'finishSkipped' },
            { guard: ({ event }) => event.output === 'changes-requested', target: 'nextRound' },
            { guard: ({ event }) => event.output === 'return-upstream', target: 'recordReturn' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The following round has the author answer the evaluator's findings.
      nextRound: {
        invoke: {
          src: 'StartStageRound',
          input: ({ context }) => ({ stage: context.stage, route: 'next' }),
          onDone: [
            { guard: ({ event }) => event.output === 'opened', target: 'respond' },
            { guard: ({ event }) => event.output === 'exhausted', target: 'finishExhausted' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      respond: {
        invoke: {
          src: 'StageAuthor',
          input: ({ context }) => ({ stage: context.stage, task: 'respond' }),
          onDone: [
            { guard: ({ event }) => event.output === 'authored', target: 'evaluateResponse' },
            { guard: ({ event }) => event.output === 'needs-input', target: 'finishNeedsInput' },
            { guard: ({ event }) => event.output === 'return-upstream', target: 'recordReturn' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      evaluateResponse: {
        invoke: {
          src: 'StageEvaluator',
          input: ({ context }) => ({ stage: context.stage }),
          onDone: [
            { guard: ({ event }) => event.output === 'accepted', target: 'finishAccepted' },
            { guard: ({ event }) => event.output === 'changes-requested', target: 'nextRound' },
            { guard: ({ event }) => event.output === 'return-upstream', target: 'recordReturn' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The upstream-return allowance bounds returns; exceeding it requests attention instead.
      recordReturn: {
        invoke: {
          src: 'RecordStageReturn',
          input: ({ context }) => ({ stage: context.stage }),
          onDone: [
            { guard: ({ event }) => event.output === 'return', target: 'finishReturnUpstream' },
            { guard: ({ event }) => event.output === 'exhausted', target: 'finishExhausted' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      finishAccepted: {
        invoke: {
          src: 'StageResult',
          input: ({ context }) => ({ stage: context.stage, outcome: 'accepted' }),
          onDone: [
            { guard: ({ event }) => event.output === 'saved', target: 'accepted' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      finishSkipped: {
        invoke: {
          src: 'StageResult',
          input: ({ context }) => ({ stage: context.stage, outcome: 'skipped' }),
          onDone: [
            { guard: ({ event }) => event.output === 'saved', target: 'skipped' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      finishReturnUpstream: {
        invoke: {
          src: 'StageResult',
          input: ({ context }) => ({ stage: context.stage, outcome: 'returnUpstream' }),
          onDone: [
            { guard: ({ event }) => event.output === 'saved', target: 'returnUpstream' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      finishNeedsInput: {
        invoke: {
          src: 'StageResult',
          input: ({ context }) => ({ stage: context.stage, outcome: 'needsInput' }),
          onDone: [
            { guard: ({ event }) => event.output === 'saved', target: 'needsInput' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      finishExhausted: {
        invoke: {
          src: 'StageResult',
          input: ({ context }) => ({ stage: context.stage, outcome: 'exhausted' }),
          onDone: [
            { guard: ({ event }) => event.output === 'saved', target: 'exhausted' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      accepted: { type: 'final', output: 'accepted' },
      skipped: { type: 'final', output: 'skipped' },
      returnUpstream: { type: 'final', output: 'returnUpstream' },
      needsInput: { type: 'final', output: 'needsInput' },
      exhausted: { type: 'final', output: 'exhausted' },
      // A repository condition that prevents preparation is the child's blocked outcome.
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

/** A preparation child succeeds when it returns an evaluated terminal result. */
export const successfulOutcomes: readonly string[] = [
  'accepted',
  'skipped',
  'returnUpstream',
  'needsInput',
  'exhausted',
];

export default preparation;
