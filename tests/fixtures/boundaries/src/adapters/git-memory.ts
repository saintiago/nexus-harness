import { createMemoryServiceClient } from '../memory/index.js';

// Adapters perform external operations; they never import the Memory component.
export const adapterMemory = createMemoryServiceClient;
