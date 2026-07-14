import {defineConfig} from 'vitest/config';

// Development test config: run against TypeScript `src/` for fast iteration
// (Vitest transpiles on the fly — no build step). Mirrors the agentback
// consumer demo and the @ebarahona/loopback-* portfolio house-style.
//
// A separate `vitest.dist.config.ts` runs the full suite against built
// `dist/` after development (see `pnpm test:dist`).
export default defineConfig({
  // Resolve @platform/* and @platform-internal/* to their TS source via the
  // tsconfig paths (same source of truth as `tsc`) — native Vite support.
  resolve: {tsconfigPaths: true},
  test: {
    include: [
      '{apps,packages,components,infrastructure}/*/src/**/*.{test,spec}.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    watch: false,
    // Serial single-worker: LoopBack/agentback decorator metadata is process
    // global state that races under parallelism (the documented rationale
    // across every @ebarahona/loopback-* plugin's vitest config).
    isolate: true,
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15_000,
  },
});
