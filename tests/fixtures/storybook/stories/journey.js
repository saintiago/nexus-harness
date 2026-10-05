/**
 * The fixture's state-changing journey: a release that advances from idle through running to
 * complete. The story renders it and the tests exercise the same module.
 */

export const journeyStates = ['idle', 'running', 'complete'];

/** One release journey whose next() advances exactly one state. */
export function createJourney() {
  let status = journeyStates[0];
  return {
    status() {
      return status;
    },
    next() {
      const index = journeyStates.indexOf(status);
      status = journeyStates[Math.min(index + 1, journeyStates.length - 1)];
      return status;
    },
  };
}
