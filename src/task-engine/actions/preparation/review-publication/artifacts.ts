import { reviewOutputSchema } from '../../review/artifacts.js';
import type { RecordDeclaration } from '../../records.js';
export const documentationReviewsDirectory = 'parent/documentation-reviews';
export const documentationReviewDeclaration = {
  file: 'review.json',
  schema: reviewOutputSchema,
} satisfies RecordDeclaration<typeof reviewOutputSchema>;
