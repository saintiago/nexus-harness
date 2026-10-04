import { createMachine } from 'xstate';

/**
 * The idea refinement workflow: a four-role conversation between the Idea editor, the Researcher,
 * the Project guide and the Challenger. XState owns the parallel group — research and project
 * guidance — and joins it before the editor writes. It routes the bounded editor/Challenger
 * exchanges: a revision, answer or rebuttal returns to the Challenger; a focused help request
 * gathers only the requested contributions without opening a cycle; an approval publishes, and an
 * unsuitable idea, an essential author decision or an exhausted cycle limit returns to the author.
 * StartIdeaRound opens the next cycle from the route XState supplies and reports the configured
 * cycle limit as exhausted, so approval at the limit still succeeds.
 *
 * The parent supplies the captured author input and publishes the terminal decision; this child
 * reads the parent selection and returns its decision without any source capability. Bind Nexus
 * operations as promise actors with machine.provide({ actors }) before execution.
 */

export const ideaRefinement = createMachine(
  {
    id: 'idea-refinement',
    initial: 'prepare',
    output: ({ event }) => event.output,
    states: {
      // The refinement area's project worktree is prepared before any role reads the project.
      prepare: {
        invoke: {
          src: 'PrepareIdeaWorkspace',
          onDone: [
            { guard: ({ event }) => event.output === 'prepared', target: 'startSubmission' },
            { guard: ({ event }) => event.output === 'failed', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The new route opens the next submission at cycle 1.
      startSubmission: {
        invoke: {
          src: 'StartIdeaRound',
          input: { route: 'new' },
          onDone: [
            { guard: ({ event }) => event.output === 'opened', target: 'frameIdea' },
            {
              guard: ({ event }) => event.output === 'exhausted',
              target: 'blocked',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The editor frames the author's proposal before the contributions gather.
      frameIdea: {
        invoke: {
          src: 'IdeaEditor',
          input: { task: 'frame' },
          onDone: [
            { guard: ({ event }) => event.output === 'framed', target: 'gatherContributions' },
            {
              guard: ({ event }) => event.output === 'author-decision-needed',
              target: 'returnAuthorDecision',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The Researcher and the Project guide contribute concurrently; the join gates the editor.
      gatherContributions: {
        type: 'parallel',
        states: {
          research: {
            initial: 'contributing',
            states: {
              contributing: {
                invoke: {
                  src: 'Researcher',
                  input: { phase: 'initial' },
                  onDone: [
                    {
                      guard: ({ event }) => event.output === 'contributed',
                      target: 'done',
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              done: { type: 'final' },
            },
          },
          guidance: {
            initial: 'contributing',
            states: {
              contributing: {
                invoke: {
                  src: 'ProjectGuide',
                  input: { phase: 'initial' },
                  onDone: [
                    {
                      guard: ({ event }) => event.output === 'contributed',
                      target: 'done',
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              done: { type: 'final' },
            },
          },
        },
        onDone: 'editIdea',
      },
      // The editor writes the refined idea revision from both contributions.
      editIdea: {
        invoke: {
          src: 'IdeaEditor',
          input: { task: 'edit' },
          onDone: [
            { guard: ({ event }) => event.output === 'written', target: 'challenge' },
            { guard: ({ event }) => event.output === 'unsuitable', target: 'returnUnsuitable' },
            {
              guard: ({ event }) => event.output === 'author-decision-needed',
              target: 'returnAuthorDecision',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The Challenger recommends approval or discusses the current revision and response.
      challenge: {
        invoke: {
          src: 'Challenger',
          onDone: [
            { guard: ({ event }) => event.output === 'approve', target: 'publishApproved' },
            { guard: ({ event }) => event.output === 'discuss', target: 'startNextCycle' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // Another cycle opens within the configured limit; the limit returns the idea to its author.
      startNextCycle: {
        invoke: {
          src: 'StartIdeaRound',
          input: { route: 'next' },
          onDone: [
            { guard: ({ event }) => event.output === 'opened', target: 'editorResponse' },
            {
              guard: ({ event }) => event.output === 'exhausted',
              target: 'returnAttemptsExhausted',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The editor answers the Challenger: revise, answer, rebut, ask for help or return.
      editorResponse: {
        invoke: {
          src: 'IdeaEditor',
          input: { task: 'respond' },
          onDone: [
            { guard: ({ event }) => event.output === 'responded', target: 'challenge' },
            {
              guard: ({ event }) => event.output === 'help-requested',
              target: 'gatherFocusedContributions',
            },
            { guard: ({ event }) => event.output === 'unsuitable', target: 'returnUnsuitable' },
            {
              guard: ({ event }) => event.output === 'author-decision-needed',
              target: 'returnAuthorDecision',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // Only the requested contributors answer the focused questions, inside the same cycle.
      gatherFocusedContributions: {
        type: 'parallel',
        states: {
          research: {
            initial: 'contributing',
            states: {
              contributing: {
                invoke: {
                  src: 'Researcher',
                  input: { phase: 'focused' },
                  onDone: [
                    {
                      guard: ({ event }) =>
                        event.output === 'contributed' || event.output === 'not-requested',
                      target: 'done',
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              done: { type: 'final' },
            },
          },
          guidance: {
            initial: 'contributing',
            states: {
              contributing: {
                invoke: {
                  src: 'ProjectGuide',
                  input: { phase: 'focused' },
                  onDone: [
                    {
                      guard: ({ event }) =>
                        event.output === 'contributed' || event.output === 'not-requested',
                      target: 'done',
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              done: { type: 'final' },
            },
          },
        },
        onDone: 'editorResponseAfterHelp',
      },
      // With the focused help in hand the editor answers the Challenger; no second help loop.
      editorResponseAfterHelp: {
        invoke: {
          src: 'IdeaEditor',
          input: { task: 'respond-after-help' },
          onDone: [
            { guard: ({ event }) => event.output === 'responded', target: 'challenge' },
            { guard: ({ event }) => event.output === 'unsuitable', target: 'returnUnsuitable' },
            {
              guard: ({ event }) => event.output === 'author-decision-needed',
              target: 'returnAuthorDecision',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      publishApproved: {
        invoke: {
          src: 'RecordIdeaDecision',
          input: { decision: 'approved' },
          onDone: [{ guard: ({ event }) => event.output === 'recorded', target: 'approved' }],
        },
      },
      returnUnsuitable: {
        invoke: {
          src: 'RecordIdeaDecision',
          input: { decision: 'unsuitable' },
          onDone: [{ guard: ({ event }) => event.output === 'recorded', target: 'unsuitable' }],
        },
      },
      returnAuthorDecision: {
        invoke: {
          src: 'RecordIdeaDecision',
          input: { decision: 'author-decision-needed' },
          onDone: [
            { guard: ({ event }) => event.output === 'recorded', target: 'author-decision-needed' },
          ],
        },
      },
      returnAttemptsExhausted: {
        invoke: {
          src: 'RecordIdeaDecision',
          input: { decision: 'attempts-exhausted' },
          onDone: [
            { guard: ({ event }) => event.output === 'recorded', target: 'attempts-exhausted' },
          ],
        },
      },
      // The parent owns publication and the terminal experience analysis.
      approved: { type: 'final', output: 'approved' },
      unsuitable: { type: 'final', output: 'unsuitable' },
      'author-decision-needed': { type: 'final', output: 'author-decision-needed' },
      'attempts-exhausted': { type: 'final', output: 'attempts-exhausted' },
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

// The parent invokes this definition as a child actor: the default export is the definition and
// successfulOutcomes names the decision outcomes the parent publishes. Blocked is not successful.
export const successfulOutcomes: readonly string[] = [
  'approved',
  'unsuitable',
  'author-decision-needed',
  'attempts-exhausted',
];

export default ideaRefinement;
