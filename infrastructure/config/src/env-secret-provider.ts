// EnvSecretProvider — the dev/local SecretProvider backend (docs/design/001-edge-authn-design.md
// AUTH-1). Resolves `secret://env/<path...>` by mapping the path onto an environment variable name:
// segments are uppercased, dashes/dots become underscores, segments join with '_'
// (e.g. `secret://env/sms-webhook-signing` → SMS_WEBHOOK_SIGNING). The cloud secret-manager
// implementation (AWS/GCP/Vault, TTL cache, rotation
// policies) swaps in behind the same port; this backend is flagged as dev-only (S1/S2).
import type {
  ResolvedSecret,
  SecretProvider,
  SecretRef,
} from '@hermes-one/contracts';

const ENV_STORE_PREFIX = 'secret://env/';

export function envVarNameFor(ref: SecretRef): string {
  const path = (ref as string).slice(ENV_STORE_PREFIX.length);
  return path
    .split('/')
    .map(seg => seg.replace(/[-.]/g, '_').toUpperCase())
    .join('_');
}

export class EnvSecretProvider implements SecretProvider {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async resolve(ref: SecretRef): Promise<ResolvedSecret> {
    if (!(ref as string).startsWith(ENV_STORE_PREFIX)) {
      throw new Error(
        `EnvSecretProvider only resolves the 'env' store, got: ${ref}`,
      );
    }
    const name = envVarNameFor(ref);
    const value = this.env[name];
    if (!value) throw new Error(`secret not found: ${ref} (env ${name} unset)`); // fail-closed, no value leakage
    return {value, version: 'env', resolvedAt: new Date().toISOString()};
  }

  invalidate(): void {
    /* env has no cache — every resolve reads the current process env */
  }
}
