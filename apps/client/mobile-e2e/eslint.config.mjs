import {configs as wdio} from 'eslint-plugin-wdio';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Scoped to this directory only: the rest of the repository has no ESLint. The suite is type-checked by tsconfig.json and
// the Bun unit tests by tsconfig.unit.json; both projects are linted so a floating promise fails in either.
export default tseslint.config(
  {ignores: ['.appium/**', 'reports/**']},
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {parserOptions: {project: ['./tsconfig.json', './tsconfig.unit.json'], tsconfigRootDir: import.meta.dirname}, globals: globals.node},
    rules: {'@typescript-eslint/no-floating-promises': 'error', '@typescript-eslint/no-misused-promises': 'error'},
  },
  {files: ['specs/**/*.ts', 'pageobjects/**/*.ts', 'support/!(*.test).ts'], ...wdio['flat/recommended']},
);
