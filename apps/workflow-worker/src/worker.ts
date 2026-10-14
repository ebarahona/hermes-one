// workflow-worker: hosts the workflows ONLY (no activities) on the
// `hermes-workflow` task queue. Edge effects run on activity-worker, the agent
// turn on agent-worker. Connects to local Temporal (127.0.0.1:7233).
//
// MIGRATED onto the LB4 composition layer (Phase 2a): the MINIMAL root
// (`WorkflowWorkerRoot`) — a bare @loopback Context, NOT a RestApplication:
// no components, no repositories, no Redis/Qdrant, only config. Workflow code must stay
// deterministic/replay-safe (ADR-014), so nothing that does I/O is ever bound here.
import 'reflect-metadata';
import {fileURLToPath} from 'node:url';
import {Context} from '@loopback/context';
import {NativeConnection, Worker} from '@temporalio/worker';
import {loadConfig, type HermesConfig} from '@platform-internal/config';
import type {CompositionRoot} from '@platform/contracts';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {WORKFLOW_QUEUE} from './queues.js';

export {WORKFLOW_QUEUE} from './queues.js';

/** The minimal, pure root (ADR-014): only config + the Temporal worker. */
export class WorkflowWorkerRoot implements CompositionRoot<Context> {
  private worker: Worker | undefined;

  constructor(private readonly config: HermesConfig) {}

  createApp(): Context {
    return new Context('workflow-worker'); // minimal container, NOT a RestApplication
  }

  bindPorts(app: Context): void {
    app.bind(PlatformBindings.CONFIG.key).to(this.config);
    // No I/O binding exists here — the workflow sandbox is deterministic (ADR-014).
  }

  registerComponents(): void {
    /* none — workflow code must stay deterministic/replay-safe */
  }

  async start(): Promise<void> {
    /* nothing to connect */
  }

  async createWorker(): Promise<Worker> {
    const connection = await NativeConnection.connect({address: this.config.temporal.address});
    this.worker = await Worker.create({
      connection,
      namespace: this.config.temporal.namespace,
      workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
      // NO activities registered here (activities live on activity-worker/agent-worker).
      taskQueue: WORKFLOW_QUEUE,
    });
    return this.worker;
  }

  async serve(_app: Context, stop: AbortSignal): Promise<void> {
    const worker = this.worker ?? (await this.createWorker());
    await worker.runUntil(new Promise<void>(res => stop.addEventListener('abort', () => res())));
  }

  async stop(): Promise<void> {
    /* no pools */
  }
}

export async function createWorkflowWorker(): Promise<Worker> {
  const cfg = loadConfig();
  const root = new WorkflowWorkerRoot(cfg);
  const app = root.createApp();
  root.bindPorts(app);
  root.registerComponents();
  await root.start();
  return root.createWorker();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const worker = await createWorkflowWorker();
  console.log(
    `workflow-worker: polling '${WORKFLOW_QUEUE}' on ${loadConfig().temporal.address}`,
  );
  await worker.run();
}
