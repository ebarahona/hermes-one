// The envelope-encryption seam for tenant provider credentials (ADR-026). The cipher is a PORT so
// the wrapping key's home is a composition-root choice: LocalAesGcmCipher (below) for dev/test and
// single-box deploys; a cloud-KMS adapter (per-tenant CMK, via
// TenantMasterKeyRef) is the production swap — SAME port, no store change. Plaintext bundles exist
// only in memory between decrypt and ProviderExecutionContext.config; they never touch a column,
// a log, or a definition body.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type {TenantId} from '@platform/contracts';

export interface CredentialCipher {
  /** Encrypt one tenant's bundle. `keyRef` names the wrapping key for rotation-aware decrypt. */
  encrypt(
    tenantId: TenantId,
    plaintext: string,
  ): Promise<{ciphertext: string; keyRef: string}>;
  decrypt(
    tenantId: TenantId,
    ciphertext: string,
    keyRef: string,
  ): Promise<string>;
}

/**
 * AES-256-GCM under a per-TENANT subkey derived from one master key (HKDF-like: sha256(master ‖
 * tenantId)) — so ciphertext never travels across tenants even if rows did, and a future per-tenant
 * CMK swap changes only this class. Payload is `iv:tag:data` base64url. GCM authenticates: a
 * tampered ciphertext or the WRONG tenant's subkey fails decryption loudly, never returns garbage.
 */
export class LocalAesGcmCipher implements CredentialCipher {
  private readonly master: Buffer;
  private readonly keyId: string;

  /** `masterKeyHex`: 64 hex chars (32 bytes). Comes from config/env at the composition root ONLY. */
  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
      throw new Error(
        'LocalAesGcmCipher: masterKey must be 64 hex chars (32 bytes)',
      );
    }
    this.master = Buffer.from(masterKeyHex, 'hex');
    // Key IDENTITY for keyRef — a fingerprint, never material.
    this.keyId = createHash('sha256')
      .update(this.master)
      .digest('hex')
      .slice(0, 16);
  }

  private subkey(tenantId: TenantId): Buffer {
    return createHash('sha256')
      .update(this.master)
      .update(String(tenantId))
      .digest();
  }

  async encrypt(
    tenantId: TenantId,
    plaintext: string,
  ): Promise<{ciphertext: string; keyRef: string}> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.subkey(tenantId), iv);
    const data = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: `${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`,
      keyRef: `local:${this.keyId}`,
    };
  }

  async decrypt(
    tenantId: TenantId,
    ciphertext: string,
    keyRef: string,
  ): Promise<string> {
    if (keyRef !== `local:${this.keyId}`) {
      throw new Error(
        `credential wrapped under a different key (${keyRef}) — rotate or supply that key`,
      );
    }
    const parts = ciphertext.split(':');
    if (parts.length !== 3)
      throw new Error('credential ciphertext malformed — expected iv:tag:data');
    const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'));
    // Full 16-byte GCM tag ONLY: Node accepts truncated (4/8/12-byte) tags, which would let a
    // DB-level tamperer forge with 2^-32 instead of 2^-128 work. authTagLength pins the decipher too.
    if (tag.length !== 16)
      throw new Error(
        `credential auth tag must be 16 bytes, got ${tag.length}`,
      );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.subkey(tenantId),
      iv,
      {authTagLength: 16},
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }
}
