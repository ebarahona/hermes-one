// ADR-026 semantics, hermetic: envelope encryption round-trips per tenant, tampering and cross-tenant
// decryption fail LOUDLY (GCM auth), rotation is an upsert, revocation fail-closes and never falls
// through to platform defaults.
import {describe, expect, it} from 'vitest';
import type {CapabilityName, TenantId} from '@platform/contracts';
import {LocalAesGcmCipher} from './credential-cipher.js';
import {
  EnvelopeCredentialStore,
  FallbackCredentialStore,
  RevokedCredentialsError,
  type CredentialRow,
  type CredentialRowStore,
} from './envelope-credential-store.js';
import {
  MissingCredentialsError,
  StaticProviderCredentialStore,
} from './static-credential-store.js';

const KEY = 'a'.repeat(64);
const TNT_A = 'tnt_a' as TenantId;
const TNT_B = 'tnt_b' as TenantId;
const CAP = 'messaging.reply.send' as CapabilityName;

class MemoryRows implements CredentialRowStore {
  rows = new Map<string, CredentialRow>();
  private k(t: string, p: string, c: string) {
    return `${t}|${p}|${c}`;
  }
  async get(t: TenantId, p: string, c: CapabilityName) {
    return this.rows.get(this.k(t, p, c)) ?? null;
  }
  async upsert(row: CredentialRow) {
    this.rows.set(this.k(row.tenantId, row.providerId, row.capability), row);
  }
  async setStatus(
    t: TenantId,
    p: string,
    c: CapabilityName,
    status: CredentialRow['status'],
  ) {
    const row = this.rows.get(this.k(t, p, c));
    if (row) this.rows.set(this.k(t, p, c), {...row, status});
    return row !== undefined;
  }
}

describe('LocalAesGcmCipher', () => {
  it('round-trips per tenant and never stores plaintext', async () => {
    const cipher = new LocalAesGcmCipher(KEY);
    const {ciphertext, keyRef} = await cipher.encrypt(
      TNT_A,
      '{"authToken":"tok_secret"}',
    );
    expect(ciphertext).not.toContain('tok_secret');
    expect(keyRef).toMatch(/^local:[0-9a-f]{16}$/);
    expect(await cipher.decrypt(TNT_A, ciphertext, keyRef)).toBe(
      '{"authToken":"tok_secret"}',
    );
  });

  it("REFUSES another tenant's ciphertext — per-tenant subkeys, not one shared key", async () => {
    const cipher = new LocalAesGcmCipher(KEY);
    const {ciphertext, keyRef} = await cipher.encrypt(TNT_A, '{"a":"1"}');
    await expect(cipher.decrypt(TNT_B, ciphertext, keyRef)).rejects.toThrow();
  });

  it('REFUSES tampered ciphertext (GCM auth) and foreign keyRefs, loudly', async () => {
    const cipher = new LocalAesGcmCipher(KEY);
    const {ciphertext, keyRef} = await cipher.encrypt(TNT_A, '{"a":"1"}');
    const [iv, tag, data] = ciphertext.split(':');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 0xff;
    await expect(
      cipher.decrypt(
        TNT_A,
        `${iv}:${tag}:${flipped.toString('base64url')}`,
        keyRef,
      ),
    ).rejects.toThrow();
    await expect(
      cipher.decrypt(TNT_A, ciphertext, 'local:deadbeefdeadbeef'),
    ).rejects.toThrow(/different key/);
  });

  it('REFUSES a truncated auth tag — full 16-byte GCM tag only, no degraded forgery resistance', async () => {
    const cipher = new LocalAesGcmCipher(KEY);
    const {ciphertext, keyRef} = await cipher.encrypt(TNT_A, '{"a":"1"}');
    const [iv, tag, data] = ciphertext.split(':');
    const truncated = Buffer.from(tag, 'base64url')
      .subarray(0, 8)
      .toString('base64url');
    await expect(
      cipher.decrypt(TNT_A, `${iv}:${truncated}:${data}`, keyRef),
    ).rejects.toThrow(/16 bytes/);
  });

  it('REFUSES a malformed payload (wrong segment count), typed not TypeError', async () => {
    const cipher = new LocalAesGcmCipher(KEY);
    const {ciphertext, keyRef} = await cipher.encrypt(TNT_A, '{"a":"1"}');
    await expect(
      cipher.decrypt(TNT_A, ciphertext.replace(/:[^:]*$/, ''), keyRef),
    ).rejects.toThrow(/malformed/);
  });

  it('rejects a malformed master key at construction', () => {
    expect(() => new LocalAesGcmCipher('short')).toThrow(/64 hex/);
  });
});

describe('EnvelopeCredentialStore', () => {
  const store = () =>
    new EnvelopeCredentialStore(
      new MemoryRows(),
      new LocalAesGcmCipher(KEY),
      () => new Date(0),
    );

  it('rotate → resolve round-trips the bundle, frozen, with record metadata', async () => {
    const s = store();
    await s.rotate(TNT_A, 'twilio-sms', CAP, {
      accountSid: 'AC1',
      authToken: 'tok',
    });
    const rec = await s.resolve(TNT_A, 'twilio-sms', CAP);
    expect(rec.config).toEqual({accountSid: 'AC1', authToken: 'tok'});
    expect(Object.isFrozen(rec.config)).toBe(true);
    expect(rec).toMatchObject({
      tenantId: TNT_A,
      providerId: 'twilio-sms',
      capability: CAP,
      status: 'active',
    });
  });

  it('rotate REPLACES: the old bundle is gone after re-rotation', async () => {
    const s = store();
    await s.rotate(TNT_A, 'twilio-sms', CAP, {authToken: 'old'});
    await s.rotate(TNT_A, 'twilio-sms', CAP, {authToken: 'new'});
    expect((await s.resolve(TNT_A, 'twilio-sms', CAP)).config).toEqual({
      authToken: 'new',
    });
  });

  it('tenants are isolated: A’s rotate is invisible to B (fail-closed)', async () => {
    const s = store();
    await s.rotate(TNT_A, 'twilio-sms', CAP, {authToken: 'tok'});
    await expect(s.resolve(TNT_B, 'twilio-sms', CAP)).rejects.toThrow(
      MissingCredentialsError,
    );
  });

  it('revoke fail-closes until a fresh rotate', async () => {
    const s = store();
    await s.rotate(TNT_A, 'twilio-sms', CAP, {authToken: 'tok'});
    await s.revoke(TNT_A, 'twilio-sms', CAP);
    await expect(s.resolve(TNT_A, 'twilio-sms', CAP)).rejects.toThrow(
      RevokedCredentialsError,
    );
    await s.rotate(TNT_A, 'twilio-sms', CAP, {authToken: 'tok2'});
    expect((await s.resolve(TNT_A, 'twilio-sms', CAP)).config).toEqual({
      authToken: 'tok2',
    });
  });

  it('revoking a tuple with NO prior row writes a durable tombstone — resolve is revoked, not missing', async () => {
    const s = store();
    await s.revoke(TNT_A, 'twilio-sms', CAP);
    await expect(s.resolve(TNT_A, 'twilio-sms', CAP)).rejects.toThrow(
      RevokedCredentialsError,
    );
    // a later rotate re-provisions the tuple exactly like any other row
    await s.rotate(TNT_A, 'twilio-sms', CAP, {authToken: 'tok3'});
    expect((await s.resolve(TNT_A, 'twilio-sms', CAP)).config).toEqual({
      authToken: 'tok3',
    });
  });
});

describe('FallbackCredentialStore (tenant rows over platform defaults)', () => {
  const layered = () => {
    const envelope = new EnvelopeCredentialStore(
      new MemoryRows(),
      new LocalAesGcmCipher(KEY),
    );
    return {
      envelope,
      store: new FallbackCredentialStore(
        envelope,
        new StaticProviderCredentialStore({'twilio-sms': {from: 'platform'}}),
      ),
    };
  };

  it('a tenant without its own bundle rides the platform default', async () => {
    const {store} = layered();
    expect((await store.resolve(TNT_A, 'twilio-sms', CAP)).config).toEqual({
      from: 'platform',
    });
  });

  it('a tenant WITH its own bundle gets it — no deploy, just a rotate()', async () => {
    const {store} = layered();
    await store.rotate(TNT_A, 'twilio-sms', CAP, {from: 'tenant-own'});
    expect((await store.resolve(TNT_A, 'twilio-sms', CAP)).config).toEqual({
      from: 'tenant-own',
    });
    // and a DIFFERENT tenant still rides the platform default
    expect((await store.resolve(TNT_B, 'twilio-sms', CAP)).config).toEqual({
      from: 'platform',
    });
  });

  it('REVOKED never falls through to the platform bundle — revocation is a kill-switch', async () => {
    const {store} = layered();
    await store.rotate(TNT_A, 'twilio-sms', CAP, {from: 'tenant-own'});
    await store.revoke(TNT_A, 'twilio-sms', CAP);
    await expect(store.resolve(TNT_A, 'twilio-sms', CAP)).rejects.toThrow(
      RevokedCredentialsError,
    );
  });

  it('revoking a tuple that never had a row STILL kills the platform fallback (tombstone, fail-closed)', async () => {
    const {store} = layered();
    // before: the tenant rides the platform bundle
    expect((await store.resolve(TNT_A, 'twilio-sms', CAP)).config).toEqual({
      from: 'platform',
    });
    await store.revoke(TNT_A, 'twilio-sms', CAP);
    // after: fail-closed — never the platform bundle again for this tuple
    await expect(store.resolve(TNT_A, 'twilio-sms', CAP)).rejects.toThrow(
      RevokedCredentialsError,
    );
    // an unaffected tenant still rides the platform default
    expect((await store.resolve(TNT_B, 'twilio-sms', CAP)).config).toEqual({
      from: 'platform',
    });
  });

  it('an unknown provider stays fail-closed through BOTH layers', async () => {
    const {store} = layered();
    await expect(store.resolve(TNT_A, 'nope', CAP)).rejects.toThrow(
      MissingCredentialsError,
    );
  });
});
