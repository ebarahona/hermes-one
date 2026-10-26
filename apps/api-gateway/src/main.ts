// api-gateway process entrypoint: the inbound webhook ingress, wired from config. The destination
// number → tenant map and per-tenant rule parameters come from config.gateway; the HMAC signing
// secret resolves through the SecretRef seam (secret://env/sms-webhook-signing → SMS_WEBHOOK_SIGNING).
import {loadConfig} from '@hermes-one/config';
import type {TenantId} from '@hermes-one/contracts';
import {createInboundGateway} from './index.js';

const {gateway: gw} = loadConfig();

try {
  const gateway = await createInboundGateway({
    tenantByNumber: to => (gw.numbers[to] as TenantId | undefined) ?? null,
    parametersFor: tenantId => gw.ruleParameters[tenantId] ?? {},
  });
  await new Promise<void>(resolve =>
    gateway.server.listen(gw.port, gw.host, resolve),
  );
  console.log(`[api-gateway] listening on http://${gw.host}:${gw.port}`);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      gateway.server.close();
      void gateway.close().then(() => process.exit(0));
    });
  }
} catch (err) {
  // Boot failure is fatal: never run half-wired.
  console.error('[api-gateway] fatal', err);
  process.exit(1);
}
