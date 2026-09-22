// Rejected: the data-contract module holds no runtime I/O (docs/architecture.md §2).
import { readFile } from 'node:fs/promises';

export type FixtureReadFile = typeof readFile;
