// Applies the dependency-boundary rules used for src/ to the fixtures in this
// directory, so a test can prove that one import is permitted and another is
// rejected by the same rules the real configuration uses.
//
// Both boundaries apply to every fixture here, so their pattern lists are
// combined into a single rule rather than spread under the same key.
import tseslint from 'typescript-eslint';
import {
  dataModuleImportPatterns,
  helperImportPatterns,
  restrictImports,
} from '../../../eslint.config.js';

export default [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: restrictImports([...helperImportPatterns, ...dataModuleImportPatterns]),
  },
];
