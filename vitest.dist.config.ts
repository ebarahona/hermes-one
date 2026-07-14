import {defineConfig} from 'vitest/config';

// Post-development test config: run the full suite against BUILT `dist/` so
// the exact code path downstream consumers import is what's exercised
// (agentback's own convention). Requires `pnpm -r build` first — wired via
// `pnpm test:dist`.
export default defineConfig({
  test: {
    include: [
      '{apps,packages,components,infrastructure}/*/dist/**/*.{test,spec}.js',
    ],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    globals: false,
    watch: false,
    isolate: true,
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15_000,
  },
});
