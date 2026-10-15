// composeCandidateRegressionCheck (OB6): the check loads the CANDIDATE's own contracts, derives the
// scope-gated tool set, plays the golden case through the ONE turn loop against the mock provider
// plane — and a required-case failure BLOCKS.
import {describe, expect, it} from 'vitest';
import type {
  CapabilityContract,
  DeploymentRef,
  GoldenConversationCase,
} from '@platform/contracts';
import type {Decider} from '@platform-internal/agent-runtime';
import {
  composeCandidateRegressionCheck,
  type CandidateCheckDeps,
} from './candidate-check.js';

const H = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;
const NOW = '2026-07-14T00:00:00.000Z';

const slotReadContract = {
  definitionId: 'def_slot_read',
  kind: 'capability',
  version: '1.0.0',
  contentHash: H('c'),
  validatedAt: NOW,
  schemaRef: 'slot-read.capability/v1',
  name: 'appointment.slot.read',
  title: 'Read slots',
  description: 'List open slots.',
  inputJsonSchema: {type: 'object'},
  outputJsonSchema: {type: 'object'},
  sideEffect: 'read',
  changedDomains: ['none'],
  idempotency: {required: false, keyFields: [], ttlSeconds: 86400},
  confirm: false,
  requiredScope: 'appointment.slot.read',
  providerMapping: {
    providers: [{providerId: 'mock', priority: 100}],
    eligibility: [],
    onNoProvider: 'fail',
  },
} as unknown as CapabilityContract;

const engineContract = {
  definitionId: 'def_engine',
  kind: 'agent-engine',
  version: '1.0.0',
  contentHash: H('e'),
  validatedAt: NOW,
  schemaRef: 'assistant.agent-engine/v1',
  body: {
    persona: 'sim',
    objectives: ['book'],
    allowedCapabilities: ['appointment.slot.read'],
    referencedRules: [],
    model: {provider: 'local', model: 'x', temperature: 0},
    promptTemplateIds: [],
  },
};

const goldenCase: GoldenConversationCase = {
  caseId: 'eval_gate_case',
  tenantId: null,
  vertical: null,
  name: 'must consult the scheduler',
  severity: 'required',
  turns: [{text: 'reschedule me', attachments: []}],
  assertions: [
    {
      kind: 'tool-called',
      capability: 'appointment.slot.read',
      atStepOrLater: 0,
    },
    {kind: 'turn-outcome', outcome: 'replied'},
  ],
  version: '1.0.0',
  updatedAt: NOW,
  updatedBy: 'prn_test',
} as unknown as GoldenConversationCase;

const candidate = {
  deploymentId: 'dpl_cand',
  tenantId: 'tnt_gate',
  version: '1.0.1',
} as DeploymentRef;

const goodScript: Decider = {
  propose: step =>
    step === 0
      ? {
          kind: 'tool',
          call: {
            toolCallId: 'tc_0',
            capability: 'appointment.slot.read',
            input: {date: 'x'},
            idempotencyKey: 'i0',
            proposedAt: NOW,
          } as never,
          usage: {inputTokens: 1, outputTokens: 1, costUsd: 0},
        }
      : {
          kind: 'done',
          reply: 'Booked for 9am.',
          usage: {inputTokens: 1, outputTokens: 1, costUsd: 0},
        },
};
const lazyScript: Decider = {
  propose: () => ({
    kind: 'done',
    reply: 'All set!',
    usage: {inputTokens: 1, outputTokens: 1, costUsd: 0},
  }),
};

const depsWith = (script: Decider): CandidateCheckDeps => ({
  members: {
    tenantId: 'tnt_gate' as CandidateCheckDeps['members']['tenantId'],
    agentEngine: {
      definitionId: 'def_engine',
      contentHash: H('e'),
    } as CandidateCheckDeps['members']['agentEngine'],
    policy: {
      planId: 'pln_pol',
      contentHash: H('p'),
    } as CandidateCheckDeps['members']['policy'],
    capabilities: [
      {
        definitionId: 'def_slot_read',
        contentHash: H('c'),
      } as CandidateCheckDeps['members']['capabilities'][number],
    ],
  },
  loadContract: async (_t, definitionId) =>
    definitionId === 'def_engine' ? engineContract : slotReadContract,
  loadPlan: async () => ({planId: 'pln_pol', contentHash: H('p')}),
  suite: [goldenCase],
  script: () => script,
  toolOutput: () => ({slots: ['9am']}),
});

describe('composeCandidateRegressionCheck (OB6)', () => {
  it('PASSES when the scripted turn satisfies every assertion (real turn loop, mock providers)', async () => {
    const check = composeCandidateRegressionCheck(depsWith(goodScript));
    expect(await check(candidate)).toEqual({pass: true});
  });

  it('BLOCKS when a required case fails (the model replied without consulting the scheduler)', async () => {
    const check = composeCandidateRegressionCheck(depsWith(lazyScript));
    const gate = await check(candidate);
    expect(gate.pass).toBe(false);
    expect(gate.failedCaseIds).toEqual(['eval_gate_case']);
  });

  it('the mock executor stamps ToolResult metadata from the CANDIDATE contract (not fixtures)', async () => {
    // sideEffect 'read' + changedDomains ['none'] come from slotReadContract — assert indirectly:
    // a read tool never blocks the ungated sim and the tool-called assertion sees the capability name.
    const check = composeCandidateRegressionCheck(depsWith(goodScript));
    expect((await check(candidate)).pass).toBe(true);
  });
});
