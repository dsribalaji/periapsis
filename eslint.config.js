import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', window: 'readonly', document: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Simulation code must take time as a parameter. Use the clock.' },
      ],
    },
  },
  {
    // The physics core must stay pure: no React, no Three.js, no DOM, no ambient time.
    files: ['src/core/**/*.ts', 'src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['react', 'react-dom', 'three', '**/ui/**', '../ui/**', '**/three/**'],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Core is deterministic: pass time in.' },
        {
          object: 'Math',
          property: 'random',
          message: 'Core is deterministic: pass randomness in.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Core is deterministic: pass time in.' },
        { name: 'fetch', message: 'No network at runtime.' },
        { name: 'localStorage', message: 'Persistence lives in the storage layer.' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
);
