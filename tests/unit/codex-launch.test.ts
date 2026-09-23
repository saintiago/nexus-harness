/**
 * The launch every coding turn is given: the fixed interface the adapter
 * appends to the configured prefix, and what the one read-only diagnostic
 * launch refuses to be launched under.
 *
 * The prefix is configuration and chooses a runtime, a profile, or a model; it
 * never replaces the adapter's own arguments or widens a policy the adapter
 * states itself. These decisions need no process: they are read from the
 * documented argument lists and from the prefix alone (`docs/WORKFLOW.md` §1
 * and §11), so they are decided here rather than through a started runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_EXEC_ARGUMENTS,
  codexExecArguments,
  diagnosticLaunchProblem,
} from '../../src/agents/codex/runtime.js';

describe('the launch every coding turn is given', () => {
  it('is the explicit unsandboxed form, in the documented shape', () => {
    expect(CODEX_EXEC_ARGUMENTS).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--sandbox',
      'danger-full-access',
      '--json',
      '-',
    ]);
    // The policy that would carve `.git` out read-only is not used anywhere, in
    // either spelling: a turn has to stage and commit inside its working copy.
    const line = CODEX_EXEC_ARGUMENTS.join(' ');
    expect(line).not.toContain('workspace-write');
    expect(line).not.toContain('permissions.');
    expect(line).not.toContain('default_permissions');
    // Unattended and machine-readable: no approval is ever requested, and the
    // event stream the adapter parses comes last, with the prompt on standard
    // input.
    expect(CODEX_EXEC_ARGUMENTS.indexOf('--ask-for-approval')).toBe(0);
    expect(CODEX_EXEC_ARGUMENTS[1]).toBe('never');
    expect(CODEX_EXEC_ARGUMENTS.slice(-2)).toEqual(['--json', '-']);
  });

  it('narrows the diagnostic policy to the turn’s own working root', () => {
    expect(codexExecArguments('workspace-write')).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.writable_roots=[]',
      '-c',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '--json',
      '-',
    ]);
    // A coding turn carries no such override: the narrowing belongs to the one
    // launch that must not change what it inspects.
    const coding = codexExecArguments('danger-full-access').join(' ');
    expect(coding).not.toContain('sandbox_workspace_write');
    expect(coding).not.toContain('writable_roots');
    expect(coding).not.toContain('exclude_');
  });
});

describe('what a diagnostic launch refuses in its prefix', () => {
  it('refuses every spelling of a switch its own policy cannot take back', () => {
    const refused: ReadonlyArray<{ readonly prefix: readonly string[]; readonly named: string }> = [
      { prefix: ['--add-dir', 'C:\\evidence'], named: '--add-dir' },
      { prefix: ['--add-dir=C:\\evidence'], named: '--add-dir' },
      { prefix: ['--cd', 'C:\\evidence'], named: '--cd' },
      { prefix: ['--cd=C:\\evidence'], named: '--cd' },
      { prefix: ['-C', 'C:\\evidence'], named: '-C' },
      { prefix: ['-CC:\\evidence'], named: '-C' },
      { prefix: ['--worktree'], named: '--worktree' },
      { prefix: ['--sandbox', 'danger-full-access'], named: '--sandbox' },
      { prefix: ['--sandbox=workspace-write'], named: '--sandbox' },
      { prefix: ['-s', 'workspace-write'], named: '-s' },
      { prefix: ['-sworkspace-write'], named: '-s' },
      {
        prefix: ['--dangerously-bypass-approvals-and-sandbox'],
        named: '--dangerously-bypass-approvals-and-sandbox',
      },
    ];

    for (const { prefix, named } of refused) {
      const problem = diagnosticLaunchProblem(prefix);
      // The refusal names the switch and says the diagnostic was not started,
      // because nothing can undo a write a sandbox let through.
      expect(problem, prefix.join(' ')).toContain(`"${named}"`);
      expect(problem, prefix.join(' ')).toContain('was not started');
    }
  });

  it('accepts the model, the profile and every literal argument a prefix may carry', () => {
    expect(
      diagnosticLaunchProblem([
        '--profile',
        'nexus-astra',
        '--model',
        'gpt-6-astra',
        '-c',
        "sandbox_workspace_write.writable_roots=['C:\\evidence']",
      ]),
    ).toBeNull();
    // A grant stated through the policy's own configuration key is taken back
    // by the launch's later value, so it is not refused, and another runtime's
    // own switches are its literal arguments rather than this one's.
    expect(diagnosticLaunchProblem([])).toBeNull();
    expect(diagnosticLaunchProblem(['-m', 'gpt-5'])).toBeNull();
    expect(diagnosticLaunchProblem(['-c', 'model=gpt-5'])).toBeNull();
  });
});
