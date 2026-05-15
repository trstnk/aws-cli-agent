// ESLint flat config (ESLint 9+).
// Loaded as ESM because package.json has "type": "module".
//
// Scope: `src/**/*.ts` only. Compiled output (`dist/`) and dependencies are
// ignored. The config uses non-type-aware rules from typescript-eslint, which
// keeps `npm run lint` fast (no TS program build needed). If you want
// type-aware rules later, swap `tseslint.configs.recommended` for
// `tseslint.configs.recommendedTypeChecked` and add a `parserOptions.project`
// entry pointing at tsconfig.json.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Global ignores. The first object in a flat config with only `ignores`
    // applies to every later block.
    ignores: ['dist/**', 'node_modules/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Allow `_`-prefixed unused vars and args — useful for tool callbacks
      // where the second arg of `tool.execute` (the context) is often unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // We use empty catch blocks intentionally to never crash on log writes.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
