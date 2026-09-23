import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    // Boundary fixtures are intentionally violating samples, cruised by
    // tests/boundaries.test.ts; the local validation cache holds generated files.
    ignores: ['dist/**', 'coverage/**', '.turbo/**', 'tests/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
