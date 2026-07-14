// Task queues for the split worker topology. The workflow runs on WORKFLOW_QUEUE
// (workflow-worker); it schedules edge effects on ACTIVITY_QUEUE (activity-worker)
// and the agent turn on AGENT_QUEUE (agent-worker). Each plane scales its own
// worker independently (ADR-024).
export const WORKFLOW_QUEUE = 'hermes-workflow';
export const ACTIVITY_QUEUE = 'hermes-activity';
export const AGENT_QUEUE = 'hermes-agent';
