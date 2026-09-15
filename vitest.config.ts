import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suites are independent, so one worker may run several files and skip the per-file spawn.
    isolate: false,
  },
});
