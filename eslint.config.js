import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Builds a `no-restricted-imports` rule from gitignore-style import patterns.
 * Shared with tests/fixtures/boundaries, which applies the same rules to small
 * sample modules to show that one import is permitted and another is rejected.
 */
export function restrictImports(patterns) {
  return { 'no-restricted-imports': ['error', { patterns }] };
}

/**
 * Dependency boundary: a helper module must not import the CLI. The CLI depends
 * on helpers, never the other way round (docs/architecture.md §3).
 */
export const helperImportPatterns = [
  {
    group: ['**/cli', '**/cli.*'],
    message: 'Helper modules must not import cli.ts; the CLI depends on them, not the reverse.',
  },
];

/**
 * Dependency boundary: the data-contract module stays free of runtime I/O
 * (docs/architecture.md §2: "types.ts has no runtime I/O").
 */
export const dataModuleImportPatterns = [
  {
    group: ['node:*'],
    message: 'shared/types.ts holds data contracts only; keep runtime I/O out of it.',
  },
];

export default [
  {
    // Fixtures are intentionally failing samples; tests lint them with their own
    // config. The local validation cache holds no lintable file today, and
    // naming it keeps that from becoming accidental: a cache the linter read
    // would invalidate itself.
    ignores: ['dist/**', 'coverage/**', '.harness/**', '.turbo/**', 'tests/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    name: 'harness/helpers-do-not-import-cli',
    files: ['src/**/*.ts'],
    ignores: ['src/cli.ts'],
    rules: restrictImports(helperImportPatterns),
  },
  {
    // A later config wins for the same rule id, so the data module repeats the
    // helper boundary instead of dropping it: it must not import the CLI either.
    name: 'harness/data-module-boundaries',
    files: ['src/shared/types.ts'],
    rules: restrictImports([...helperImportPatterns, ...dataModuleImportPatterns]),
  },
];
