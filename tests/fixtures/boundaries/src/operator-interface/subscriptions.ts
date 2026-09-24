import { application } from '../application/index.js';
// Bypassing the public module for the internal worker entry must be reported.
import { workerEntry } from '../application/worker.js';

export const subscriptions = { application, workerEntry };
