import { createMemoryServiceClient } from '../memory/index.js';

// Application must construct the action's capability without importing the Memory component.
export const applicationMemory = createMemoryServiceClient;
