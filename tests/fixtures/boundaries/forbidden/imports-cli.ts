// Rejected: a helper module must not import the CLI (docs/architecture.md §3).
import { runCli } from '../../../../src/cli.js';

export type FixtureRunCli = typeof runCli;
