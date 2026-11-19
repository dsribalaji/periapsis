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
    // The UI may read the wall clock. The restriction above exists because simulation code must
    // take time as a parameter, and nothing under `src/ui` computes physics: the one use here is
    // stamping a saved scenario with the instant it was saved, which is metadata rather than a
    // simulation input and is never read back into the clock.
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'No network at runtime.' }],
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
  {
    // Dev scripts run under Node but hand code to `page.evaluate`, which executes it in the
    // browser. Both sets of globals are therefore legitimately in scope, and the file is not
    // part of the app bundle.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        document: 'readonly',
        createImageBitmap: 'readonly',
        // `performance` and the DOM constructors below are used inside `page.evaluate`, which
        // runs the code in the browser, and by the benchmark's own Node timing.
        performance: 'readonly',
        ImageData: 'readonly',
        HTMLSelectElement: 'readonly',
        Event: 'readonly',
        PerformanceObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
);
