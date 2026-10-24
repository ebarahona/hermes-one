// Live-PG integration for the DeploymentController reads: boots admin-api WITH Persistence +
// the SubstrateComponent (which binds DeploymentService over the content-addressed store) and drives
// the deployment read routes with real api-key principals. Proves the wiring + gates: a fresh tenant
// with no deployment → 404 (a real round-trip DeploymentService → store → RLS query), the scope gate
// (deployment.read), and the tenant boundary. The 200-with-a-real-deployment happy path needs a full
// publish to seed — deferred to the deployment WRITE work; the same store read methods are already
// exercised by the agent-worker e2e (which publishes then reads deployments). Needs the compose PG stack.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {loadConfig} from '@hermes-one/config';
import type {PlatformRestApplication} from '@hermes-one/loopback-core';
import type {ApiKeySeed} from '@hermes-one/auth';
import type {PrincipalId, Scope, TenantId} from '@hermes-one/contracts';
import {AdminApiRoot} from './root.js';

const TENANT = 'tnt_deploy_itest' as TenantId;
const OTHER = 'tnt_deploy_other';
const KEY_READ = 'itest-deploy-read';
const KEY_NOSCOPE = 'itest-deploy-noscope';

const key = (k: string, principalId: string, scopes: Scope[]): ApiKeySeed => ({
  key: k,
  record: {
    keyId: `apk_${principalId}`,
    tenantId: TENANT,
    principalId: principalId as PrincipalId,
    scopes,
    status: 'active',
    expiresAt: null,
  },
});

let app: PlatformRestApplication;
let base: string;

beforeAll(async () => {
  const loaded = loadConfig();
  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY_READ, 'prn_svc_dread', ['deployment.read'] as Scope[]),
      key(KEY_NOSCOPE, 'prn_svc_dnoscope', ['tenant.role.read'] as Scope[]), // a scope, NOT deployment.read
    ],
  });
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  base = app.restServer.url!;
});

afterAll(async () => {
  await app?.stop();
});

describe('GET /v1/deployments/active (live)', () => {
  it('a scoped principal on a tenant with no deployment → 404 (round-trip through the store)', async () => {
    const res = await fetch(
      `${base}/v1/deployments/active?tenantId=${TENANT}`,
      {headers: {'x-api-key': KEY_READ}},
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe(
      'not_found',
    );
  });

  it('a specific version that does not exist → 404', async () => {
    const res = await fetch(`${base}/v1/deployments/${TENANT}/9.9.9`, {
      headers: {'x-api-key': KEY_READ},
    });
    expect(res.status).toBe(404);
  });

  it('a principal without deployment.read → 403 forbidden_scope', async () => {
    const res = await fetch(
      `${base}/v1/deployments/active?tenantId=${TENANT}`,
      {headers: {'x-api-key': KEY_NOSCOPE}},
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe(
      'forbidden_scope',
    );
  });

  it('reading another tenant’s deployment → 403 (tenant boundary, never the query’s tenant)', async () => {
    const res = await fetch(`${base}/v1/deployments/active?tenantId=${OTHER}`, {
      headers: {'x-api-key': KEY_READ},
    });
    expect(res.status).toBe(403);
    const byVersion = await fetch(`${base}/v1/deployments/${OTHER}/1.0.0`, {
      headers: {'x-api-key': KEY_READ},
    });
    expect(byVersion.status).toBe(403);
  });

  it('unauthenticated → 401 (before routing)', async () => {
    const res = await fetch(`${base}/v1/deployments/active?tenantId=${TENANT}`);
    expect(res.status).toBe(401);
  });
});
