// send-sms: POST a signed inbound SMS webhook to the gateway, as a channel provider would. The body is
// signed with HMAC-SHA256 over `rawBody + '.' + timestamp` (the gateway's AUTH-1 posture), so it is
// accepted once; the gateway answers 202 with the started workflow's id.
//
//   pnpm send-sms "I forgot my password"
//
// Env: HERMES_GATEWAY_URL (default http://127.0.0.1:3002), SMS_WEBHOOK_SIGNING, SMS_TO, and SMS_FROM
// (defaults match the compose quickstart, infra/quickstart.env).
import {createHmac} from 'node:crypto';

const base = process.env.HERMES_GATEWAY_URL ?? 'http://127.0.0.1:3002';
const secret =
  process.env.SMS_WEBHOOK_SIGNING ?? 'hermes-quickstart-webhook-secret';
const to = process.env.SMS_TO ?? '+15125550100';
const from = process.env.SMS_FROM ?? '+15125559999';

async function main() {
  const text = process.argv.slice(2).join(' ');
  if (!text) throw new Error('usage: pnpm send-sms "<message text>"');

  const rawBody = JSON.stringify({
    From: from,
    To: to,
    Body: text,
    MessageSid: `SM_${Date.now()}`,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret)
    .update(`${rawBody}.${timestamp}`)
    .digest('hex');

  const res = await fetch(`${base}/webhooks/sms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': signature,
      'x-timestamp': timestamp,
    },
    body: rawBody,
  });
  if (res.status !== 202)
    throw new Error(`gateway returned ${res.status}: ${await res.text()}`);
  const {workflowId} = (await res.json()) as {workflowId: string};
  console.log(`Started ${workflowId}`);
  console.log(
    `Watch it: http://localhost:8233/namespaces/default/workflows/${workflowId}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
