import { createGit } from '../adapters/git.js';
import { develop } from './actions/develop/index.js';

export const createExecutionRunner = { createGit, develop };
