import { createMemoryServiceClient } from '../../../memory/index.js';

// Another action must not import the Memory component either; AnalyzeExperience owns it.
export const reviewMemory = createMemoryServiceClient;
