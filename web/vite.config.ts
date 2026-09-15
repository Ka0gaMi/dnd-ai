import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/ws': { target: 'ws://127.0.0.1:8765', ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suites are independent, so one worker may run several files: on CI this removes the
    // per-file spawn cost that dominated the web job.
    isolate: false,
  },
});
