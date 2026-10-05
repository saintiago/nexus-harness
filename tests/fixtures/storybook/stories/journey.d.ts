/** The types of the fixture's journey module, which stays plain JavaScript for Storybook. */
export const journeyStates: readonly string[];
export function createJourney(): {
  status(): string;
  next(): string;
};
