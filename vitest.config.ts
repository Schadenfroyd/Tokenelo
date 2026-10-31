import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // These integration fixtures create real subprocess trees and SQLite ledgers. Bound
    // file concurrency on large farm/CI hosts; preserve every case and its original timeout.
    maxWorkers: 2,
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Tests are run by vitest's own esbuild-based transform, never by tsc (DESIGN §2.1 note:
    // "Tests compiled by vitest (not tsc)"). `npm run typecheck` (tsc --noEmit) covers src/**
    // only; it does not typecheck test/**.
    passWithNoTests: true,
  },
});
