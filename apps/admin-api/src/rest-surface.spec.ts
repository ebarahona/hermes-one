// Hermetic proof of the Slice 1 REST surface — boots the real LB4 RestApplication on an ephemeral
// port (no backing stack: Slice 1 binds no datasource) and drives the sequence contract over HTTP.
// Runs in `pnpm test` and the CI `verify` job. The `node dist/e2e.js` smoke asserts the same.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {loadConfig} from '@platform-internal/config';
import {AdminApiRoot} from './root.js';
import type {PlatformRestApplication} from '@platform-internal/loopback-core';

let app: PlatformRestApplication;
let base: string;

beforeAll(async () => {
  const loaded = loadConfig();
  const cfg = {...loaded, api: {...loaded.api, port: 0}}; // ephemeral (schema floors real config at 1)
  const root = new AdminApiRoot(cfg);
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  base = app.restServer.url!; // defined once the RestServer is listening
});

afterAll(async () => {
  await app?.stop();
});

describe('admin-api REST surface (Slice 1)', () => {
  it('serves the public health route with a minted correlation id', async () => {
    const res = await fetch(`${base}/v1/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({status: 'ok'});
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('echoes an inbound correlation id on the response', async () => {
    const cid = 'spec-correlation-xyz';
    const res = await fetch(`${base}/v1/healthz`, {headers: {'x-correlation-id': cid}});
    expect(res.headers.get('x-correlation-id')).toBe(cid);
  });

  it('rejects a non-public route with 401 BEFORE routing (no 404 leak) as a PlatformError', async () => {
    const res = await fetch(`${base}/v1/whoami`);
    const text = await res.text();
    expect(res.status).toBe(401); // fail-closed authenticate runs before findRoute → 401, not 404
    const body = JSON.parse(text) as {error?: {code?: string; httpStatus?: number}};
    expect(body.error?.code).toBe('unauthorized');
    expect(body.error?.httpStatus).toBe(401);
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
    // No leakage: the generic 401 carries no route path or schema/stack detail.
    expect(text).not.toContain('whoami');
    expect(text).not.toMatch(/schema|stack|route/i);
  });
});
