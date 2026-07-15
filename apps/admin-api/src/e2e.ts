// admin-api Slice 1 e2e — boots the real LB4 REST surface on an ephemeral port and drives the
// sequence contract end-to-end (no mocks). Asserts:
//   1. GET /v1/healthz (public)      → 200, {status:'ok'}, X-Correlation-Id present (minted)
//   2. inbound x-correlation-id      → echoed on the response (Correlation-always law)
//   3. GET /v1/whoami (not public)   → 401 {error: PlatformError(unauthorized)} BEFORE route match
//                                      (fail-closed authenticate + authorize-before-validate), no leakage
// Run: `node apps/admin-api/dist/e2e.js` (no backing stack needed — Slice 1 binds no datasource).
import 'reflect-metadata';
import {loadConfig} from '@platform-internal/config';
import {AdminApiRoot} from './root.js';

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
  const root = new AdminApiRoot(cfg);
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
