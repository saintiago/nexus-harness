import { assign, createMachine } from 'xstate';
import {
  councilVerdicts,
  type CouncilReviewer,
} from '../src/task-engine/actions/review-council/artifacts.js';

/**
 * The idea refinement workflow. XState owns the two parallel groups — purpose/research and the
 * three independent council reviews — and joins each group before the next operation starts. The
 * routing guards apply the documented verdict precedence, and StartIdeaRound opens every cycle from
 * the route XState supplies and reports the configured council-cycle limit as exhausted.
 *
 * Bind Nexus operations as promise actors with machine.provide({ actors }) before execution.
 */

/** The council verdicts the machine routes on, held as control state rather than artifacts. */
type IdeaContext = {
  readonly verdicts: Partial<Record<CouncilReviewer, string>>;
};

/** The verdicts recorded so far, in reviewer order. */
function verdictsOf(context: IdeaContext): string[] {
  return [context.verdicts.purpose, context.verdicts.evidence, context.verdicts.simplicity].filter(
    (verdict): verdict is string => typeof verdict === 'string',
  );
}

/** True when one council reviewer returned a declared verdict. */
function isVerdict(output: unknown): boolean {
  return councilVerdicts.some((verdict) => verdict === output);
}

export const ideaRefinement = createMachine(
  {
    id: 'idea-refinement',
    initial: 'selectIdea',
    context: { verdicts: {} as Partial<Record<CouncilReviewer, string>> },
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
      // The route XState supplies opens the next cycle; a new submission starts cycle 1.
      startSubmission: {
        invoke: {
          src: 'StartIdeaRound',
          input: { route: 'new' },
          onDone: [
            { guard: ({ event }) => event.output === 'opened', target: 'assessAndResearch' },
            { guard: ({ event }) => event.output === 'exhausted', target: 'blocked' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // Purpose and research run independently; the writer starts only after both finish.
      assessAndResearch: {
        type: 'parallel',
        states: {
          purpose: {
            initial: 'assess',
            states: {
              assess: {
                invoke: {
                  src: 'PurposeVerifier',
                  onDone: [
                    {
                      guard: ({ event }) => event.output === 'reported',
                      target: 'assessed',
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              assessed: { type: 'final' },
            },
          },
          research: {
            initial: 'research',
            states: {
              research: {
                invoke: {
                  src: 'Researcher',
                  onDone: [
                    {
                      guard: ({ event }) => event.output === 'reported',
                      target: 'researched',
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              researched: { type: 'final' },
            },
          },
        },
        onDone: 'writeBrief',
      },
      writeBrief: {
        invoke: {
          src: 'BriefWriter',
          onDone: [
            { guard: ({ event }) => event.output === 'written', target: 'reviewCouncil' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // The three reviewers run independently; routing waits for all three to save their results.
      reviewCouncil: {
        type: 'parallel',
        states: {
          purpose: {
            initial: 'review',
            states: {
              review: {
                invoke: {
                  src: 'PurposeCouncil',
                  onDone: [
                    {
                      guard: ({ event }) => isVerdict(event.output),
                      target: 'reviewed',
                      actions: assign({
                        verdicts: ({ context, event }) => ({
                          ...context.verdicts,
                          purpose: String(event.output),
                        }),
                      }),
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              reviewed: { type: 'final' },
            },
          },
          evidence: {
            initial: 'review',
            states: {
              review: {
                invoke: {
                  src: 'EvidenceCouncil',
                  onDone: [
                    {
                      guard: ({ event }) => isVerdict(event.output),
                      target: 'reviewed',
                      actions: assign({
                        verdicts: ({ context, event }) => ({
                          ...context.verdicts,
                          evidence: String(event.output),
                        }),
                      }),
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              reviewed: { type: 'final' },
            },
          },
          simplicity: {
            initial: 'review',
            states: {
              review: {
                invoke: {
                  src: 'SimplicityCouncil',
                  onDone: [
                    {
                      guard: ({ event }) => isVerdict(event.output),
                      target: 'reviewed',
                      actions: assign({
                        verdicts: ({ context, event }) => ({
                          ...context.verdicts,
                          simplicity: String(event.output),
                        }),
                      }),
                    },
                    { actions: 'unexpectedOutcome' },
                  ],
                },
              },
              reviewed: { type: 'final' },
            },
          },
        },
        onDone: 'routeVerdicts',
      },
      // Precedence: idea_not_working > major_rework > minor_corrections > unanimous approval.
      routeVerdicts: {
        always: [
          {
            guard: ({ context }) => verdictsOf(context).includes('idea_not_working'),
            target: 'returnToAuthor',
          },
          {
            guard: ({ context }) =>
              verdictsOf(context).length === 3 &&
              verdictsOf(context).every((verdict) => verdict === 'approve'),
            target: 'publishApproved',
          },
          {
            guard: ({ context }) => verdictsOf(context).includes('major_rework'),
            target: 'startMajorCycle',
          },
          { target: 'startMinorCycle' },
        ],
      },
      // Minor corrections repeat the writer and the council on the existing reports.
      startMinorCycle: {
        invoke: {
          src: 'StartIdeaRound',
          input: { route: 'minor' },
          onDone: [
            { guard: ({ event }) => event.output === 'opened', target: 'writeBrief' },
            {
              guard: ({ event }) => event.output === 'exhausted',
              target: 'returnUnableToConverge',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      // Major rework repeats purpose, research, the writer and the council.
      startMajorCycle: {
        invoke: {
          src: 'StartIdeaRound',
          input: { route: 'major' },
          onDone: [
            { guard: ({ event }) => event.output === 'opened', target: 'assessAndResearch' },
            {
              guard: ({ event }) => event.output === 'exhausted',
              target: 'returnUnableToConverge',
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
            { guard: ({ event }) => event.output === 'approved', target: 'approved' },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      returnToAuthor: {
        invoke: {
          src: 'PublishDecision',
          input: { decision: 'returned-to-author' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'waitingForFeedback',
            },
            { actions: 'unexpectedOutcome' },
          ],
        },
      },
      returnUnableToConverge: {
        invoke: {
          src: 'PublishDecision',
          input: { decision: 'unable-to-converge' },
          onDone: [
            {
              guard: ({ event }) => event.output === 'waiting-for-feedback',
              target: 'waitingForFeedback',
            },
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
