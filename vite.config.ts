import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1400,
  },
  server: { port: 5183, strictPort: false },
  preview: { port: 5184, strictPort: false },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/sim/**', 'src/scenarios/**'],
      reporter: ['text-summary'],
    },
  },
});
