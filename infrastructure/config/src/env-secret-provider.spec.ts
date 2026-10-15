// Unit tests for the dev/local SecretProvider backend (AUTH-1).
import {describe, expect, it} from 'vitest';
import {SecretRef} from '@platform/contracts';
import {EnvSecretProvider, envVarNameFor} from './env-secret-provider.js';

describe('EnvSecretProvider', () => {
  it('maps secret://env/<path> onto the env var name (upper, -/. → _, / → _)', () => {
    expect(
      envVarNameFor(SecretRef.parse('secret://env/sms-webhook-signing')),
    ).toBe('SMS_WEBHOOK_SIGNING');
    expect(envVarNameFor(SecretRef.parse('secret://env/oidc/acme.jwks'))).toBe(
      'OIDC_ACME_JWKS',
    );
  });

  it('resolves from the injected env and fails closed (no value leakage) when unset', async () => {
    const provider = new EnvSecretProvider({SMS_WEBHOOK_SIGNING: 'shh'});
    const got = await provider.resolve(
      SecretRef.parse('secret://env/sms-webhook-signing'),
    );
    expect(got.value).toBe('shh');
    expect(got.version).toBe('env');
    await expect(
      provider.resolve(SecretRef.parse('secret://env/missing-secret')),
    ).rejects.toThrow(/secret not found: secret:\/\/env\/missing-secret/);
  });

  it('refuses refs from any other store', async () => {
    const provider = new EnvSecretProvider({});
    await expect(
      provider.resolve(SecretRef.parse('secret://vault/x/y')),
    ).rejects.toThrow(/only resolves/);
  });

  it('SecretRef grammar rejects malformed pointers', () => {
    expect(() => SecretRef.parse('secret://env')).toThrow(); // store with no path
    expect(() => SecretRef.parse('secrets://env/x')).toThrow();
    expect(() => SecretRef.parse('secret://ENV/x')).toThrow(); // uppercase store
  });
});
