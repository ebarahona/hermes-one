// Live-PG proof of ADR-026's credential spine: migration 0030 applies, the full chain
// (EnvelopeCredentialStore over DrizzleCredentialRowStore) round-trips per tenant under RLS, the
// DATABASE never sees plaintext, revocation fail-closes, and a text-GUC session sees only its own
// tenant's rows (strict isolation — the same posture as every other tenant table).
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import type {CapabilityName, TenantId} from '@platform/contracts';
import {
  EnvelopeCredentialStore,
  LocalAesGcmCipher,
  MissingCredentialsError,
  RevokedCredentialsError,
} from '@platform-internal/secrets';
import {runMigrations} from './migrate.js';
import {createCredentialRowStore, type CredentialRowStoreHandle} from './client.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const KEY = 'b'.repeat(64);
const TNT_A = 'tnt_pvc_itest_a' as TenantId;
const TNT_B = 'tnt_pvc_itest_b' as TenantId;
const CAP = 'messaging.reply.send' as CapabilityName;

let owner: Pool;
let rows: CredentialRowStoreHandle;
let store: EnvelopeCredentialStore;

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  rows = createCredentialRowStore(PG);
  store = new EnvelopeCredentialStore(rows.repo, new LocalAesGcmCipher(KEY));
  await owner.query(`DELETE FROM capability.provider_credentials WHERE tenant_id IN ($1, $2)`, [TNT_A, TNT_B]);
});

afterAll(async () => {
  await owner.query(`DELETE FROM capability.provider_credentials WHERE tenant_id IN ($1, $2)`, [TNT_A, TNT_B]);
  await owner.end();
  await rows.close();
});

describe('provider_credentials (live, RLS)', () => {
  it('rotate → resolve round-trips through Postgres, and the ROW never holds plaintext', async () => {
    await store.rotate(TNT_A, 'twilio-sms', CAP, {accountSid: 'AC_itest', authToken: 'tok_secret_itest'});
    const rec = await store.resolve(TNT_A, 'twilio-sms', CAP);
    expect(rec.config).toEqual({accountSid: 'AC_itest', authToken: 'tok_secret_itest'});

    const raw = await owner.query(
      `SELECT ciphertext, key_ref, status FROM capability.provider_credentials WHERE tenant_id = $1`,
      [TNT_A],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0].ciphertext).not.toContain('tok_secret_itest');
    expect(raw.rows[0].ciphertext).not.toContain('AC_itest');
    expect(raw.rows[0].key_ref).toMatch(/^local:/);
    expect(raw.rows[0].status).toBe('active');
  });

  it('re-rotation REPLACES in place (unique tuple, upsert) — still one row', async () => {
    await store.rotate(TNT_A, 'twilio-sms', CAP, {accountSid: 'AC_v2', authToken: 'tok_v2'});
    expect((await store.resolve(TNT_A, 'twilio-sms', CAP)).config).toEqual({accountSid: 'AC_v2', authToken: 'tok_v2'});
    const n = await owner.query(`SELECT count(*)::int AS n FROM capability.provider_credentials WHERE tenant_id = $1`, [TNT_A]);
    expect(n.rows[0].n).toBe(1);
  });

  it("tenant B cannot resolve A's credentials (store) and cannot SEE the row (RLS GUC session)", async () => {
    await expect(store.resolve(TNT_B, 'twilio-sms', CAP)).rejects.toThrow(MissingCredentialsError);

    // Straight to the RLS posture: a platform_app session pinned to B sees zero of A's rows.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE platform_app`);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TNT_B]);
      const visible = await client.query(`SELECT count(*)::int AS n FROM capability.provider_credentials`);
      expect(visible.rows[0].n).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('revoke fail-closes at the live store until a fresh rotate', async () => {
    await store.revoke(TNT_A, 'twilio-sms', CAP);
    await expect(store.resolve(TNT_A, 'twilio-sms', CAP)).rejects.toThrow(RevokedCredentialsError);
    await store.rotate(TNT_A, 'twilio-sms', CAP, {accountSid: 'AC_v3', authToken: 'tok_v3'});
    expect((await store.resolve(TNT_A, 'twilio-sms', CAP)).status).toBe('active');
  });
});
