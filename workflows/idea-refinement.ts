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
 * Bind Nexus operations as promise actors with machine.provide({ actors }) before execution.
 */

/**
 * AnalyzeExperience's capture outcomes; all three preserve the publication destination, so a
 * skipped or unavailable capture never changes what the author is told or which queue item runs.
 */
const experienceOutcomes: readonly string[] = ['recorded', 'skipped', 'unavailable'];

/** Whether one AnalyzeExperience outcome preserves the original destination. */
const preservesDestination = ({ event }: { readonly event: { readonly output: unknown } }) =>
  typeof event.output === 'string' && experienceOutcomes.includes(event.output);

export const ideaRefinement = createMachine(
  {
    id: 'idea-refinement',
    initial: 'selectIdea',
    output: ({ event }) => event.output,
    states: {
      // One selection path for a first submission and a resubmission after human feedback.
      selectIdea: {
        invoke: {
          src: 'SelectIdea',
          onDone: [
            { guard: ({ event }) => event.output === 'selected', target: 'startSubmission' },
            { guard: ({ event }) => event.output === 'empty', target: 'drained' },
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
              target: 'analyzeStartSubmissionExhausted',
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
          src: 'PublishDecision',
          input: { decision: 'approved' },
          onDone: [
            { guard: ({ event }) => event.output === 'approved', target: 'analyzeApproved' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      returnUnsuitable: {
        invoke: {
          src: 'PublishDecision',
          input: { decision: 'unsuitable' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'analyzeUnsuitable',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      returnAuthorDecision: {
        invoke: {
          src: 'PublishDecision',
          input: { decision: 'author-decision-needed' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'analyzeAuthorDecision',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      returnAttemptsExhausted: {
        invoke: {
          src: 'PublishDecision',
          input: { decision: 'attempts-exhausted' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'analyzeAttemptsExhausted',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // One handoff state per terminal publication: approval and the three author returns are
      // terminal, while conversation cycles, focused help and empty/failed selection stay
      // intermediate work that never reaches AnalyzeExperience.
      analyzeApproved: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'publish-approved' },
          onDone: [
            { guard: preservesDestination, target: 'approved' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeUnsuitable: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'publish-unsuitable' },
          onDone: [
            { guard: preservesDestination, target: 'waitingForFeedback' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeAuthorDecision: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'publish-author-decision' },
          onDone: [
            { guard: preservesDestination, target: 'waitingForFeedback' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeAttemptsExhausted: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'publish-attempts-exhausted' },
          onDone: [
            { guard: preservesDestination, target: 'waitingForFeedback' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      analyzeStartSubmissionExhausted: {
        invoke: {
          src: 'AnalyzeExperience',
          input: { terminal: 'start-submission-exhausted' },
          onDone: [
            { guard: preservesDestination, target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      drained: { type: 'final', output: 'drained' },
      approved: { type: 'final', output: 'approved' },
      waitingForFeedback: { type: 'final', output: 'waiting-for-feedback' },
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

// Application loads this module for the explicitly selected idea refinement workflow: the default
// export is the definition and successfulOutcomes names its successful terminal outcomes. A
// returned idea and an empty queue are successful endings; blocked is not.
export const successfulOutcomes: readonly string[] = [
  'approved',
  'waiting-for-feedback',
  'drained',
];

export default ideaRefinement;
