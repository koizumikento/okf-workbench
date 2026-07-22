import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  Buffer: 'readonly',
  console: 'readonly',
  process: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '.vscode-test/**',
      'artifacts/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: ['test/extension/**/*.mjs'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        suite: 'readonly',
        test: 'readonly',
      },
    },
  },
);
