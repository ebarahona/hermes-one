// workflow-worker: hosts the workflows ONLY (no activities) on the
// `hermes-workflow` task queue. Edge effects run on activity-worker, the agent
// turn on agent-worker. Connects to local Temporal (127.0.0.1:7233).
import {fileURLToPath} from 'node:url';
import {NativeConnection, Worker} from '@temporalio/worker';
import {loadConfig} from '@platform-internal/config';
import {WORKFLOW_QUEUE} from './queues.js';

export {WORKFLOW_QUEUE} from './queues.js';

export async function createWorkflowWorker(): Promise<Worker> {
  const cfg = loadConfig();
  const connection = await NativeConnection.connect({
    address: cfg.temporal.address,
  });
  return Worker.create({
    connection,
    namespace: cfg.temporal.namespace,
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
    taskQueue: WORKFLOW_QUEUE,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const worker = await createWorkflowWorker();
  console.log(
    `workflow-worker: polling '${WORKFLOW_QUEUE}' on ${loadConfig().temporal.address}`,
  );
  await worker.run();
}
