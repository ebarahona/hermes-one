// Live-PG integration for the DefinitionController PUT (Slice 8): boots admin-api WITH Persistence +
// the SubstrateComponent (which binds DefinitionRegistry with the logic-DSL compilers) and authors a
// real capability definition over HTTP. Proves the write path end-to-end: PUT → validate-and-pin →
// content-hash → store (a real PutDefinitionResult with a contentHash), plus the scope gate, the
// tenant boundary, and envelope validation. Uses the `capability` kind (contract-schema — no compiler)
// as the happy path. Content-addressed, so re-runs are idempotent (no cleanup needed). Needs the PG stack.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {loadConfig} from '@platform-internal/config';
import type {PlatformRestApplication} from '@platform-internal/loopback-core';
import type {ApiKeySeed} from '@platform-internal/auth';
import type {PrincipalId, Scope, TenantId} from '@platform/contracts';
import {AdminApiRoot} from './root.js';

const TENANT = 'tnt_def_itest' as TenantId;
const KEY_WRITE = 'itest-def-write';
const KEY_NOSCOPE = 'itest-def-noscope';

const key = (k: string, principalId: string, scopes: Scope[]): ApiKeySeed => ({
  key: k,
  record: {keyId: `apk_${principalId}`, tenantId: TENANT, principalId: principalId as PrincipalId, scopes, status: 'active', expiresAt: null},
});

// A valid capability definition body (mirrors apps/workflow-worker/src/publish.ts).
const capabilityBody = {
  name: 'itest.slot.read',
  title: 'Read appointment slots',
  description: 'List open appointment slots for a given date.',
  inputJsonSchema: {type: 'object', required: ['date'], properties: {date: {type: 'string'}}},
  outputJsonSchema: {type: 'object', properties: {slots: {type: 'array'}}},
  sideEffect: 'read',
  changedDomains: ['none'],
  idempotency: {required: false, keyFields: [], ttlSeconds: 86400},
  confirm: false,
  requiredScope: 'itest.slot.read',
  providerMapping: {providers: [{providerId: 'internal-scheduler', priority: 100}], eligibility: [], onNoProvider: 'fail'},
};

const putReq = (tenantId: string | null, over: Record<string, unknown> = {}) => ({
  tenantId,
  kind: 'capability',
  name: 'itest-slot-read',
  schemaRef: 'itest-slot-read.capability/v1',
  version: '1.0.0',
  body: capabilityBody,
  ...over,
});

let app: PlatformRestApplication;
let base: string;

beforeAll(async () => {
  const loaded = loadConfig();
  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY_WRITE, 'prn_svc_dwrite', ['definition.write'] as Scope[]),
      key(KEY_NOSCOPE, 'prn_svc_dnoscope', ['tenant.role.read'] as Scope[]),
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

const put = (key: string, id: string, body: unknown) =>
  fetch(`${base}/v1/definitions/${id}`, {
    method: 'PUT',
    headers: {'x-api-key': key, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });

describe('PUT /v1/definitions/{id} (live)', () => {
  it('authors a capability definition → 200 with a content hash', async () => {
    const res = await put(KEY_WRITE, 'def_itest_cap', putReq(TENANT));
    expect(res.status).toBe(200);
    const result = (await res.json()) as {definitionId: string; contentHash: string; version: string};
    expect(result.definitionId).toBe('def_itest_cap');
    expect(result.contentHash).toMatch(/^sha256:/);
    expect(result.version).toBe('1.0.0');
  });

  it('is idempotent — re-authoring the same body returns the same content hash', async () => {
    const a = (await (await put(KEY_WRITE, 'def_itest_cap', putReq(TENANT))).json()) as {contentHash: string};
    const b = (await (await put(KEY_WRITE, 'def_itest_cap', putReq(TENANT))).json()) as {contentHash: string};
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('rejects a malformed envelope → 422', async () => {
    const res = await put(KEY_WRITE, 'def_itest_bad', {kind: 'capability', name: 'x'}); // missing fields
    expect(res.status).toBe(422);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe('validation_failed');
  });

  it('rejects an invalid capability body → 422 (registry validation)', async () => {
    const res = await put(KEY_WRITE, 'def_itest_badbody', putReq(TENANT, {body: {name: 'x'}}));
    expect(res.status).toBe(422);
  });

  it('rejects a principal without definition.write → 403', async () => {
    const res = await put(KEY_NOSCOPE, 'def_itest_cap', putReq(TENANT));
    expect(res.status).toBe(403);
  });

  it('rejects authoring for another tenant (or platform) → 403', async () => {
    expect((await put(KEY_WRITE, 'def_itest_cap', putReq('tnt_someone_else'))).status).toBe(403);
    expect((await put(KEY_WRITE, 'def_itest_cap', putReq(null))).status).toBe(403);
  });

  it('unauthenticated → 401 (before routing)', async () => {
    const res = await fetch(`${base}/v1/definitions/def_itest_cap`, {method: 'PUT', headers: {'content-type': 'application/json'}, body: '{}'});
    expect(res.status).toBe(401);
  });
});
