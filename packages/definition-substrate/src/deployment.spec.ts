import {describe, expect, it} from 'vitest';
import type {DeploymentMember, DeploymentRef, PrincipalId, SemVer, TenantId} from '@platform/contracts';
import {DeploymentService, type PublishDeploymentInput} from './deployment.js';
import type {DeploymentWritePort, PlanStorePort} from './ports.js';

const H = `sha256:${'0'.repeat(64)}`;
const member = (kind: DeploymentMember['kind'], id: string, planId: string | null): DeploymentMember =>
  ({kind, definitionId: `def_${id}`, planId, version: '1.0.0', contentHash: H} as unknown as DeploymentMember);

const input = (): PublishDeploymentInput => ({
  tenantId: 'tnt_gate' as TenantId,
  workflow: member('workflow', 'wf', 'pln_wf'),   // logic-dsl → planId required
  agentEngine: member('agent-engine', 'eng', null), // contract-schema → planId null
  policy: member('policy', 'pol', 'pln_pol'),      // logic-dsl → planId required
  rules: [member('rule', 'rule', 'pln_rule')],
  capabilities: [member('capability', 'cap', null)],
  operatorRegistryVersion: '1.0.0' as SemVer,
  actor: 'prn_gate' as PrincipalId,
});

function fakes() {
  const calls = {published: 0};
  const deployments = {
    latestVersion: async () => null,
    publish: async () => {
      calls.published++;
    },
    repointActive: async () => {},
  } as unknown as DeploymentWritePort;
  const store = {
    resolvePlanCached: async () => ({}),
    resolveActiveDeploymentCached: async () => ({}),
    invalidateActiveDeployment: async () => {},
  } as unknown as PlanStorePort;
  return {calls, deployments, store};
}

describe('DeploymentService.publish — regression gate', () => {
  it('commits when no gate is configured (backward compatible)', async () => {
    const {calls, deployments, store} = fakes();
    const svc = new DeploymentService({store, deployments, now: () => '2026-07-13T00:00:00.000Z'});
    const ref = await svc.publish(input());
    expect(calls.published).toBe(1);
    expect((ref as DeploymentRef).tenantId).toBe('tnt_gate');
  });

  it('commits when the regression gate passes', async () => {
    const {calls, deployments, store} = fakes();
    const svc = new DeploymentService({
      store, deployments, now: () => '2026-07-13T00:00:00.000Z',
      regressionCheck: async () => ({pass: true}),
    });
    await svc.publish(input());
    expect(calls.published).toBe(1);
  });

  it('ABORTS (throws, nothing written) when the regression gate fails', async () => {
    const {calls, deployments, store} = fakes();
    const svc = new DeploymentService({
      store, deployments, now: () => '2026-07-13T00:00:00.000Z',
      regressionCheck: async () => ({pass: false, reason: '2 required golden case(s) failed'}),
    });
    await expect(svc.publish(input())).rejects.toThrow(/regression gate.*required golden case/);
    expect(calls.published).toBe(0); // the atomic supersede+insert never ran
  });

  it('runs the gate with the CANDIDATE ref (deploymentId + version)', async () => {
    const {deployments, store} = fakes();
    let seen: DeploymentRef | undefined;
    const svc = new DeploymentService({
      store, deployments, now: () => '2026-07-13T00:00:00.000Z',
      regressionCheck: async ref => {
        seen = ref;
        return {pass: true};
      },
    });
    await svc.publish(input());
    expect(seen!.version).toBe('1.0.0');
    expect(seen!.deploymentId).toContain('dpl_');
  });
});

describe('DeploymentService.resolveVersion (replay + audit)', () => {
  it('resolves a specific historical version through the store port', async () => {
    const {deployments, store} = fakes();
    const historical = {deploymentId: 'dpl_old', tenantId: 'tnt_gate', version: '1.0.1', status: 'superseded'};
    let asked: {tenantId: string; version: string} | undefined;
    (store as {resolveDeploymentByVersion?: unknown}).resolveDeploymentByVersion = async (
      tenantId: string,
      version: string,
    ) => {
      asked = {tenantId, version};
      return historical;
    };
    const svc = new DeploymentService({store, deployments, now: () => '2026-07-13T00:00:00.000Z'});
    const got = await svc.resolveVersion('tnt_gate' as TenantId, '1.0.1' as SemVer);
    expect(asked).toEqual({tenantId: 'tnt_gate', version: '1.0.1'});
    expect(got).toBe(historical);
  });
});
