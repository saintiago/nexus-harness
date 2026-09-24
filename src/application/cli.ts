#!/usr/bin/env node
/**
 * The runnable Nexus command entry point. The installed launch shortcut invokes it with the
 * operator's arguments, working directory, environment and standard streams; behavior lives in the
 * operator command.
 */

import { runOperatorCommand } from './command.js';

process.exitCode = await runOperatorCommand({
  args: process.argv.slice(2),
  workingDirectory: process.cwd(),
  environment: process.env,
  output: process.stdout,
  diagnostics: process.stderr,
});
