import {defineConfig} from 'vitest/config';

// Integration test config: *.itest.ts files that require the live backing stack
// (infra/docker-compose — Postgres, Redis). Kept OUT of the default `pnpm test`
// glob so `pnpm verify` stays hermetic. Run explicitly with `pnpm test:itest`.
export default defineConfig({
  resolve: {tsconfigPaths: true},
  test: {
    include: ['{apps,packages,components,infrastructure}/*/src/**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    watch: false,
    isolate: true,
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
