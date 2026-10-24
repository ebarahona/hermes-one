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
import {loadConfig} from '@hermes-one/config';
import type {ApiKeySeed} from '@hermes-one/auth';
import type {PrincipalId, Scope, TenantId} from '@hermes-one/contracts';
import {AdminApiRoot} from './root.js';

const API_KEY = 'dev-key-e2e-xyz';
const SEEDS: ApiKeySeed[] = [
  {
    key: API_KEY,
    record: {
      keyId: 'apk_e2e',
      tenantId: 'tnt_admin_e2e' as TenantId,
      principalId: 'prn_svc_e2e' as PrincipalId,
      scopes: [
        'tenant.role.read',
        'tenant.role.create',
        'deployment.read',
        'platform.tenant.read',
        'definition.write',
        'deployment.publish',
        'tenant.user.create',
        'tenant.user.read',
      ] as Scope[],
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
    console.error(
      `  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`,
    );
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
    check(
      'healthz → X-Correlation-Id minted',
      !!health.headers.get('x-correlation-id'),
    );

    // 2. inbound correlation id is echoed
    const cid = 'e2e-correlation-abc';
    const echo = await fetch(`${base}/v1/healthz`, {
      headers: {'x-correlation-id': cid},
    });
    check(
      'inbound correlation id echoed',
      echo.headers.get('x-correlation-id') === cid,
    );

    // 3. non-public route → 401 before route match, PlatformError, no leakage
    const denied = await fetch(`${base}/v1/whoami`);
    const deniedText = await denied.text();
    let deniedBody: {
      error?: {code?: string; httpStatus?: number; message?: string};
    } = {};
    try {
      deniedBody = JSON.parse(deniedText);
    } catch {
      /* asserted below */
    }
    check('non-public route → 401', denied.status === 401, denied.status);
    check(
      '401 → error.code unauthorized',
      deniedBody.error?.code === 'unauthorized',
      deniedBody,
    );
    check(
      '401 → error.httpStatus 401',
      deniedBody.error?.httpStatus === 401,
      deniedBody,
    );
    check(
      '401 → X-Correlation-Id present',
      !!denied.headers.get('x-correlation-id'),
    );
    check(
      '401 → no route/schema leakage',
      !deniedText.includes('whoami') && !/schema|stack|route/i.test(deniedText),
      deniedText,
    );

    // 4. invalid api key → 401 (indistinguishable from absent)
    const badKey = await fetch(`${base}/v1/whoami`, {
      headers: {'x-api-key': 'not-a-real-key'},
    });
    const badKeyBody = (await badKey.json()) as {error?: {code?: string}};
    check('invalid api key → 401', badKey.status === 401, badKey.status);
    check(
      'invalid api key → unauthorized',
      badKeyBody.error?.code === 'unauthorized',
      badKeyBody,
    );

    // 5. valid api key → 200 + the bound service principal
    const authed = await fetch(`${base}/v1/whoami`, {
      headers: {'x-api-key': API_KEY},
    });
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
    const rolesRes = await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {
      headers: {'x-api-key': API_KEY},
    });
    const rolesBody = (await rolesRes.json()) as Array<{name?: string}>;
    check('roles read → 200', rolesRes.status === 200, rolesRes.status);
    check(
      'roles read → array incl. platform roles',
      Array.isArray(rolesBody) && rolesBody.length > 0,
      rolesBody,
    );

    // 7. tenant boundary: reading ANOTHER tenant's roles → 403 (never the path's tenant)
    const crossTenant = await fetch(
      `${base}/v1/tenants/tnt_someone_else/roles`,
      {headers: {'x-api-key': API_KEY}},
    );
    const crossBody = (await crossTenant.json()) as {error?: {code?: string}};
    check(
      'cross-tenant roles read → 403',
      crossTenant.status === 403,
      crossTenant.status,
    );
    check(
      'cross-tenant → forbidden_scope',
      crossBody.error?.code === 'forbidden_scope',
      crossBody,
    );

    // 8. write path: create a tenant role (201, or 409 on a re-run — both prove the endpoint), then
    //    confirm it lists. Re-run-safe (the e2e is intentionally re-run for idempotency discipline).
    const create = await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({name: 'e2erole', scopes: ['tenant.role.read']}),
    });
    check(
      'create role → 201 or 409 (re-run)',
      create.status === 201 || create.status === 409,
      create.status,
    );
    const after = (await (
      await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {
        headers: {'x-api-key': API_KEY},
      })
    ).json()) as Array<{name?: string}>;
    check(
      'created role appears in list',
      after.some(r => r.name === 'e2erole'),
      after,
    );

    // 9. write scope gate: a bad body → 422
    const badBody = await fetch(`${base}/v1/tenants/tnt_admin_e2e/roles`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({scopes: []}), // missing name
    });
    check('create with bad body → 422', badBody.status === 422, badBody.status);

    // 10. deployment reads (SubstrateComponent + DeploymentService): a tenant with no deployment → 404
    //     (a real round-trip through the store under RLS); another tenant → 403 (boundary).
    const activeDep = await fetch(
      `${base}/v1/deployments/active?tenantId=tnt_admin_e2e`,
      {headers: {'x-api-key': API_KEY}},
    );
    check(
      'active deployment (none) → 404',
      activeDep.status === 404,
      activeDep.status,
    );
    const crossDep = await fetch(
      `${base}/v1/deployments/active?tenantId=tnt_other_dep`,
      {headers: {'x-api-key': API_KEY}},
    );
    check(
      'cross-tenant deployment → 403',
      crossDep.status === 403,
      crossDep.status,
    );

    // 11. tenant self-service read: this tenant has no seeded row → 404 (round-trip); another tenant → 403.
    const ownTenant = await fetch(`${base}/v1/tenants/tnt_admin_e2e`, {
      headers: {'x-api-key': API_KEY},
    });
    check(
      'own tenant (no row) → 404',
      ownTenant.status === 404,
      ownTenant.status,
    );
    const crossTenantGet = await fetch(`${base}/v1/tenants/tnt_other_ten`, {
      headers: {'x-api-key': API_KEY},
    });
    check(
      'cross-tenant tenant read → 403',
      crossTenantGet.status === 403,
      crossTenantGet.status,
    );

    // 12. definition authoring (SubstrateComponent + DefinitionRegistry w/ compilers): PUT a capability
    //     definition → 200 with a content hash (idempotent, re-run-safe); another tenant → 403.
    const defBody = {
      tenantId: 'tnt_admin_e2e',
      kind: 'capability',
      name: 'e2e-slot-read',
      schemaRef: 'e2e-slot-read.capability/v1',
      version: '1.0.0',
      body: {
        name: 'e2e.slot.read',
        title: 'Read slots',
        description: 'List slots.',
        inputJsonSchema: {
          type: 'object',
          required: ['date'],
          properties: {date: {type: 'string'}},
        },
        outputJsonSchema: {
          type: 'object',
          properties: {slots: {type: 'array'}},
        },
        sideEffect: 'read',
        changedDomains: ['none'],
        idempotency: {required: false, keyFields: [], ttlSeconds: 86400},
        confirm: false,
        requiredScope: 'e2e.slot.read',
        providerMapping: {
          providers: [{providerId: 'internal-scheduler', priority: 100}],
          eligibility: [],
          onNoProvider: 'fail',
        },
      },
    };
    const putDef = await fetch(`${base}/v1/definitions/def_e2e_admin_cap`, {
      method: 'PUT',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify(defBody),
    });
    const putDefBody = (await putDef.json()) as {contentHash?: string};
    check('author definition → 200', putDef.status === 200, putDef.status);
    check(
      'definition → content hash',
      typeof putDefBody.contentHash === 'string' &&
        putDefBody.contentHash.startsWith('sha256:'),
      putDefBody,
    );
    const crossDef = await fetch(`${base}/v1/definitions/def_e2e_admin_cap`, {
      method: 'PUT',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({...defBody, tenantId: 'tnt_other_def'}),
    });
    check(
      'cross-tenant definition → 403',
      crossDef.status === 403,
      crossDef.status,
    );

    // 13. deployment preview (validateManifest, no write): a well-formed manifest → 200 ok:true; a
    //     manifest for another tenant → 403. (Publish/read-back is covered by the deployment-write itest.)
    const pick = (kind: string) => ({
      kind,
      definitionId: 'def_x',
      planId: kind === 'capability' || kind === 'agent-engine' ? null : 'pln_x',
      version: '1.0.0',
      contentHash: `sha256:${'0'.repeat(64)}`,
    });
    const manifest = {
      tenantId: 'tnt_admin_e2e',
      workflow: pick('workflow'),
      agentEngine: pick('agent-engine'),
      policy: pick('policy'),
      rules: [],
      capabilities: [],
      operatorRegistryVersion: '1.0.0',
    };
    const preview = await fetch(`${base}/v1/deployments/preview`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify(manifest),
    });
    const previewBody = (await preview.json()) as {ok?: boolean};
    check(
      'deployment preview → 200 ok:true',
      preview.status === 200 && previewBody.ok === true,
      {status: preview.status, body: previewBody},
    );
    const crossPreview = await fetch(`${base}/v1/deployments/preview`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({...manifest, tenantId: 'tnt_other_dep'}),
    });
    check(
      'cross-tenant preview → 403',
      crossPreview.status === 403,
      crossPreview.status,
    );

    // 14. user provisioning: create a service user → 201, it lists; another tenant → 403.
    const createUser = await fetch(`${base}/v1/tenants/tnt_admin_e2e/users`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({
        kind: 'service',
        displayName: 'E2E Bot',
        roleNames: ['customer'],
      }),
    });
    const createdUser = (await createUser.json()) as {principalId?: string};
    check('create user → 201', createUser.status === 201, createUser.status);
    const usersList = (await (
      await fetch(`${base}/v1/tenants/tnt_admin_e2e/users`, {
        headers: {'x-api-key': API_KEY},
      })
    ).json()) as {items: Array<{principalId: string}>};
    check(
      'created user appears in list',
      usersList.items.some(u => u.principalId === createdUser.principalId),
      createdUser,
    );
    const crossUser = await fetch(`${base}/v1/tenants/tnt_other_usr/users`, {
      method: 'POST',
      headers: {'x-api-key': API_KEY, 'content-type': 'application/json'},
      body: JSON.stringify({kind: 'user'}),
    });
    check(
      'cross-tenant user create → 403',
      crossUser.status === 403,
      crossUser.status,
    );
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
