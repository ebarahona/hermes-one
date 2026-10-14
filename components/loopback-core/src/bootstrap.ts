// The shared ESM entry contract: every main.ts
// calls bootstrap() with its own CompositionRoot; identical everywhere. reflect-metadata MUST be the
// first import in the process (ADR-022) — this module imports it, and every main.ts imports this
// module first.
import 'reflect-metadata';
import {loadConfig, type HermesConfig} from '@platform-internal/config';
import type {CompositionRoot} from '@platform/contracts';

/** Every main.ts calls this with its own root; identical everywhere. */
export async function bootstrap<TApp>(
  makeRoot: (config: HermesConfig) => CompositionRoot<TApp>,
): Promise<void> {
  const config = loadConfig(); // env -> validated typed config (Zod)
  const root = makeRoot(config);
  const app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);

  const shutdown = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => shutdown.abort());
  }

  try {
    await root.start(app); // observers connect; fail-closed tenant gate
    await root.serve(app, shutdown.signal); // HTTP listen OR Temporal worker.runUntil()
  } catch (err) {
    // Boot/serve failure is fatal — never run half-wired.
    await root.stop(app).catch(() => void 0);
    // eslint-disable-next-line no-console
    console.error('[bootstrap] fatal', err);
    process.exit(1);
  }
  await root.stop(app);
  process.exit(0);
}
