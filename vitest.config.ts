import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suites are independent, so one worker may run several files and skip the per-file spawn.
    isolate: false,
    // The world suites tick a simulated year; under a loaded machine 5 s / 10 s limits fail them spuriously.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
