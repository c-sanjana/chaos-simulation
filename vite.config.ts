/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works from any host path (here.now serves at a site root,
  // but this keeps the build portable).
  base: './',
  worker: { format: 'es' },
  test: {
    // Agents' worktrees live under .claude/; their tests are not this checkout's.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [['src/ui/**', 'jsdom']],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/**/*.worker.ts', 'src/**/*.d.ts', 'src/test-setup.ts', 'src/**/*.test.{ts,tsx}', 'src/ui/testing/**', 'src/**/testConfigs.ts', 'src/**/testRuns.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
