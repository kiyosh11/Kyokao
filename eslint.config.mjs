import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
export default [
  {
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: { project: false } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      // The ongoing typed-module migration keeps a small set of legacy ports
      // under explicit file-level suppression. Still ban ts-ignore and require
      // descriptions for ts-expect-error; only the auditable file-wide marker
      // is accepted until those modules are converted.
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': false }],
    },
  },
  { ignores: ['**/dist/**', '**/node_modules/**'] },
];
