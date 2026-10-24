// Hermetic proof of the Slice 1+2 REST surface — boots the real LB4 RestApplication on an ephemeral
// port with Persistence OFF (no backing stack) and drives the sequence + AUTH-3 api-key path over
// HTTP. Runs in `pnpm test` and the CI `verify` job. The datasource-backed roles route (Slice 3) is
// covered by roles-route.itest.ts (live PG); the `node dist/e2e.js` smoke asserts both.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {loadConfig} from '@hermes-one/config';
import type {ApiKeySeed} from '@hermes-one/auth';
import type {PrincipalId, Scope, TenantId} from '@hermes-one/contracts';
import {AdminApiRoot} from './root.js';
import type {PlatformRestApplication} from '@hermes-one/loopback-core';

const API_KEY = 'dev-key-abc123';
const SEEDS: ApiKeySeed[] = [
  {
    key: API_KEY,
    record: {
      keyId: 'apk_spec',
      tenantId: 'tnt_admin_spec' as TenantId,
      principalId: 'prn_svc_spec' as PrincipalId,
      scopes: ['tenant.role.read'] as Scope[],
      status: 'active',
      expiresAt: null,
    },
  },
];

let app: PlatformRestApplication;
let base: string;

beforeAll(async () => {
  const loaded = loadConfig();
  const cfg = {...loaded, api: {...loaded.api, port: 0}}; // ephemeral (schema floors real config at 1)
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: SEEDS,
    withPersistence: false,
  });
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  base = app.restServer.url!; // defined once the RestServer is listening
});

afterAll(async () => {
  await app?.stop();
});

describe('admin-api REST surface (Slice 1+2)', () => {
  it('serves the public health route with a minted correlation id', async () => {
    const res = await fetch(`${base}/v1/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({status: 'ok'});
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('echoes an inbound correlation id on the response', async () => {
    const cid = 'spec-correlation-xyz';
    const res = await fetch(`${base}/v1/healthz`, {
      headers: {'x-correlation-id': cid},
    });
    expect(res.headers.get('x-correlation-id')).toBe(cid);
  });

  it('rejects an unauthenticated non-public route with 401 BEFORE routing (no 404 leak)', async () => {
    const res = await fetch(`${base}/v1/whoami`);
    const text = await res.text();
    expect(res.status).toBe(401); // fail-closed authenticate runs before findRoute → 401, not 404
    const body = JSON.parse(text) as {
      error?: {code?: string; httpStatus?: number};
    };
    expect(body.error?.code).toBe('unauthorized');
    expect(body.error?.httpStatus).toBe(401);
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
    expect(text).not.toContain('whoami');
    expect(text).not.toMatch(/schema|stack|route/i);
  });

  it('rejects an unauthenticated /openapi.json with 401 — the spec surface is not public', async () => {
    const res = await fetch(`${base}/openapi.json`);
    expect(res.status).toBe(401); // full admin route/schema map — authenticated like any other route
    const body = (await res.json()) as {error?: {code?: string}};
    expect(body.error?.code).toBe('unauthorized');
  });

  it('still serves /openapi.json to an AUTHENTICATED caller (gated, not removed)', async () => {
    const res = await fetch(`${base}/openapi.json`, {
      headers: {'x-api-key': API_KEY},
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as {openapi?: string}).openapi).toBeTruthy();
  });

  it('rejects an invalid api key with 401 (no distinction from absent)', async () => {
    const res = await fetch(`${base}/v1/whoami`, {
      headers: {'x-api-key': 'not-a-real-key'},
    });
    const body = (await res.json()) as {error?: {code?: string}};
    expect(res.status).toBe(401);
    expect(body.error?.code).toBe('unauthorized');
  });

  it('authenticates a valid api key → the bound service principal (api-key strategy end-to-end)', async () => {
    const res = await fetch(`${base}/v1/whoami`, {
      headers: {'x-api-key': API_KEY},
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principalId: 'prn_svc_spec',
      tenantId: 'tnt_admin_spec',
      kind: 'service',
      scopes: ['tenant.role.read'],
    });
  });
});
