import { createMemoryServiceClient } from '../../../memory/index.js';

// AnalyzeExperience is the one automatic Memory consumer, so its own modules may import it.
export const experienceMemory = createMemoryServiceClient;
