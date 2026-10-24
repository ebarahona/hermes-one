// agent-worker (agent plane): hosts the bounded agent-turn activity on the
// `hermes-agent` task queue. Runs no workflows. Connects to local Temporal.
import {fileURLToPath} from 'node:url';
import {NativeConnection, Worker} from '@temporalio/worker';
import {loadConfig} from '@hermes-one/config';
import {withPlatformFailures} from '@hermes-one/temporal-client';
import {agentTurn, shutdownAgentWorker} from './agent-activity.js';

export const AGENT_QUEUE = 'hermes-agent';

export async function createAgentWorker(): Promise<Worker> {
  const cfg = loadConfig();
  const connection = await NativeConnection.connect({
    address: cfg.temporal.address,
  });
  return Worker.create({
    connection,
    namespace: cfg.temporal.namespace,
    // Typed failures for the retry-policy registry (retry-policy registry).
    activities: withPlatformFailures({agentTurn}),
    taskQueue: AGENT_QUEUE,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const worker = await createAgentWorker();
  console.log(
    `agent-worker: polling '${AGENT_QUEUE}' on ${loadConfig().temporal.address}`,
  );
  try {
    await worker.run();
  } finally {
    // Flush batched spans on stop so nothing is lost (no-op for the console/none exporters).
    await shutdownAgentWorker();
  }
}
