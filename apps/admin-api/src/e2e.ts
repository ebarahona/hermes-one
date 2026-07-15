// admin-api Slice 1+2 e2e — boots the real LB4 REST surface on an ephemeral port and drives the
// sequence + AUTH-3 api-key path end-to-end (no mocks). Asserts:
//   1. GET /v1/healthz (public)      → 200, {status:'ok'}, X-Correlation-Id present (minted)
//   2. inbound x-correlation-id      → echoed on the response (Correlation-always law)
//   3. GET /v1/whoami, no key        → 401 {error: PlatformError(unauthorized)} BEFORE route match
//                                      (fail-closed authenticate + authorize-before-validate), no leakage
//   4. GET /v1/whoami, bad key       → 401 (indistinguishable from absent)
//   5. GET /v1/whoami, valid api key → 200 + the bound service principal (api-key strategy)
// Run: `node apps/admin-api/dist/e2e.js` (no backing stack needed — no datasource bound).
import 'reflect-metadata';
import {loadConfig} from '@platform-internal/config';
import type {ApiKeySeed} from '@platform-internal/auth';
import type {PrincipalId, Scope, TenantId} from '@platform/contracts';
import {AdminApiRoot} from './root.js';

const API_KEY = 'dev-key-e2e-xyz';
const SEEDS: ApiKeySeed[] = [
  {
    key: API_KEY,
    record: {
      keyId: 'apk_e2e',
      tenantId: 'tnt_admin_e2e' as TenantId,
      principalId: 'prn_svc_e2e' as PrincipalId,
      scopes: ['tenant.role.read', 'tenant.role.create'] as Scope[],
      status: 'active',
      expiresAt: null,
    },
  },
];

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main(): Promise<void> {
  // Ephemeral port (0) for the test — override the loaded config (the schema floors real config at 1).
  const loaded = loadConfig();
  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {apiKeySeeds: SEEDS}); // Persistence ON → needs the PG stack
  const app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  const base = app.restServer.url; // http://127.0.0.1:<ephemeral>
  console.log(`[admin-api e2e] listening at ${base}`);

  try {
    // 1. public health route
    const health = await fetch(`${base}/v1/healthz`);
    const healthBody = (await health.json()) as {status?: string};
    check('healthz → 200', health.status === 200, health.status);
    check('healthz → {status:"ok"}', healthBody.status === 'ok', healthBody);
    check('healthz → X-Correlation-Id minted', !!health.headers.get('x-correlation-id'));

    // 2. inbound correlation id is echoed
    const cid = 'e2e-correlation-abc';
    const echo = await fetch(`${base}/v1/healthz`, {headers: {'x-correlation-id': cid}});
    check('inbound correlation id echoed', echo.headers.get('x-correlation-id') === cid);

    // 3. non-public route → 401 before route match, PlatformError, no leakage
    const denied = await fetch(`${base}/v1/whoami`);
    const deniedText = await denied.text();
    let deniedBody: {error?: {code?: string; httpStatus?: number; message?: string}} = {};
    try {
      deniedBody = JSON.parse(deniedText);
    } catch {
      /* asserted below */
    }
    check('non-public route → 401', denied.status === 401, denied.status);
    check('401 → error.code unauthorized', deniedBody.error?.code === 'unauthorized', deniedBody);
    check('401 → error.httpStatus 401', deniedBody.error?.httpStatus === 401, deniedBody);
    check('401 → X-Correlation-Id present', !!denied.headers.get('x-correlation-id'));
    check(
      '401 → no route/schema leakage',
      !deniedText.includes('whoami') && !/schema|stack|route/i.test(deniedText),
      deniedText,
    );

    // 4. invalid api key → 401 (indistinguishable from absent)
    const badKey = await fetch(`${base}/v1/whoami`, {headers: {'x-api-key': 'not-a-real-key'}});
    const badKeyBody = (await badKey.json()) as {error?: {code?: string}};
    check('invalid api key → 401', badKey.status === 401, badKey.status);
    check('invalid api key → unauthorized', badKeyBody.error?.code === 'unauthorized', badKeyBody);

    // 5. valid api key → 200 + the bound service principal
    const authed = await fetch(`${base}/v1/whoami`, {headers: {'x-api-key': API_KEY}});
    const me = (await authed.json()) as Record<string, unknown>;
    check('valid api key → 200', authed.status === 200, authed.status);
    check(
      'valid api key → bound service principal',
      me.principalId === 'prn_svc_e2e' &&
        me.tenantId === 'tnt_admin_e2e' &&
        me.kind === 'service' &&
        Array.isArray(me.scopes) &&
        (me.scopes as string[]).includes('tenant.role.read'),
      me,
    );

    // 6. datasource-backed, scope-gated, tenant-scoped read: roles for the principal's own tenant
    //    (the seeded key carries tenant.role.read). Returns ≥ the platform roles (0029 seed).
    const rolesRes = await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {headers: {'x-api-key': API_KEY}});
    const rolesBody = (await rolesRes.json()) as Array<{name?: string}>;
    check('roles read → 200', rolesRes.status === 200, rolesRes.status);
    check('roles read → array incl. platform roles', Array.isArray(rolesBody) && rolesBody.length > 0, rolesBody);

    // 7. tenant boundary: reading ANOTHER tenant's roles → 403 (never the path's tenant)
    const crossTenant = await fetch(`${base}/v1/tenants/tnt_someone_else/roles`, {headers: {'x-api-key': API_KEY}});
    const crossBody = (await crossTenant.json()) as {error?: {code?: string}};
    check('cross-tenant roles read → 403', crossTenant.status === 403, crossTenant.status);
    check('cross-tenant → forbidden_scope', crossBody.error?.code === 'forbidden_scope', crossBody);

    // 8. write path: create a tenant role (201, or 409 on a re-run — both prove the endpoint), then
    //    confirm it lists. Re-run-safe (the e2e is intentionally re-run for idempotency discipline).
    const create = await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({name: 'e2erole', scopes: ['tenant.role.read']}),
    });
    check('create role → 201 or 409 (re-run)', create.status === 201 || create.status === 409, create.status);
    const after = (await (await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {headers: {'x-api-key': API_KEY}})).json()) as Array<{name?: string}>;
    check('created role appears in list', after.some(r => r.name === 'e2erole'), after);

    // 9. write scope gate: a bad body → 422
    const badBody = await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({scopes: []}), // missing name
    });
    check('create with bad body → 422', badBody.status === 422, badBody.status);
  } finally {
    await app.stop();
  }

  if (failures > 0) {
    console.error(`\n[admin-api e2e] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n[admin-api e2e] all checks PASSED');
  process.exit(0);
}

void main();
