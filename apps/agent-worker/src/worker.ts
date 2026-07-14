// agent-worker (agent plane): hosts the bounded agent-turn activity on the
// `hermes-agent` task queue. Runs no workflows. Connects to local Temporal.
import {fileURLToPath} from 'node:url';
import {NativeConnection, Worker} from '@temporalio/worker';
import {loadConfig} from '@platform-internal/config';
import {withPlatformFailures} from '@platform-internal/temporal-client';
import {agentTurn} from './agent-activity.js';

export const AGENT_QUEUE = 'hermes-agent';

export async function createAgentWorker(): Promise<Worker> {
  const cfg = loadConfig();
  const connection = await NativeConnection.connect({
    address: cfg.temporal.address,
  });
  return Worker.create({
    connection,
    namespace: cfg.temporal.namespace,
    // Typed failures for the retry-policy registry (retry-policy-registry.md acceptance criterion 8).
    activities: withPlatformFailures({agentTurn}),
    taskQueue: AGENT_QUEUE,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const worker = await createAgentWorker();
  console.log(
    `agent-worker: polling '${AGENT_QUEUE}' on ${loadConfig().temporal.address}`,
  );
  await worker.run();
}
