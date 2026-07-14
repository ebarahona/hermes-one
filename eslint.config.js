import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

// House-style lint, aligned with the @ebarahona/loopback-* portfolio:
// typescript-eslint + prettier (prettier applied last to disable stylistic
// rules it owns). Not Biome — the published plugins standardize on this pair.
export default [
  {ignores: ['**/dist/**', '**/node_modules/**']},
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {sourceType: 'module', ecmaVersion: 2022},
    },
    plugins: {'@typescript-eslint': tseslint},
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {argsIgnorePattern: '^_'}],
    },
  },
  prettier,
];
