// @platform-internal/secrets — infrastructure (none plane). The secrets member:
// ProviderCredentialStore implementations live here so
// BOTH planes can wire them (the port itself is in @platform/contracts, ADR-026/ledger S7). The
// envelope-encrypted per-tenant store (ADR-026) is the next adapter behind the same port.
export {StaticProviderCredentialStore, MissingCredentialsError} from './static-credential-store.js';
export {LocalAesGcmCipher, type CredentialCipher} from './credential-cipher.js';
export {
  EnvelopeCredentialStore,
  FallbackCredentialStore,
  RevokedCredentialsError,
  type CredentialRow,
  type CredentialRowStore,
} from './envelope-credential-store.js';

export const descriptor = {
  name: '@platform-internal/secrets',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  governedBy: ['ADR-025', 'ADR-026'],
} as const;
