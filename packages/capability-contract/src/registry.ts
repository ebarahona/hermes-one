// The capability contract registry (ADR-016 contract-schema family: validate + pin, no compiler).
// Holds CapabilityContracts keyed by (name, version) and enforces the register-time invariants a
// capability must satisfy before it can be pinned into a deployment. Pure/in-memory: the composition
// root seeds it from the active deployment's validated_contracts.
import {
  CapabilityContract,
  PlatformErrorException,
  type CapabilityManifest,
  type CapabilityName,
  type CapabilityRegistry,
  type SemVer,
} from '@hermes-one/contracts';

const key = (name: string, version: string) => `${name}@${version}`;

/** A capability whose side effect mutates state MUST require an idempotency key. */
const MUTATING = new Set(['write', 'external', 'payment']);

export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly byNameVersion = new Map<string, CapabilityContract>();

  constructor(contracts: CapabilityContract[] = []) {
    for (const c of contracts) this.validateAndStore(c);
  }

  async register(cap: CapabilityContract): Promise<void> {
    this.validateAndStore(cap);
  }

  /** Synchronous validation core: seeding must throw in the constructor, never as an unhandled rejection. */
  private validateAndStore(cap: CapabilityContract): void {
    const parsed = CapabilityContract.parse(cap); // name grammar, base fields, enums
    if (MUTATING.has(parsed.sideEffect) && !parsed.idempotency.required) {
      throw this.invalid(
        `capability ${parsed.name}: sideEffect '${parsed.sideEffect}' requires idempotency.required=true`,
      );
    }
    if (
      (parsed.sideEffect === 'none' || parsed.sideEffect === 'read') &&
      (parsed.changedDomains.length !== 1 ||
        parsed.changedDomains[0] !== 'none')
    ) {
      throw this.invalid(
        `capability ${parsed.name}: sideEffect '${parsed.sideEffect}' must have changedDomains ['none']`,
      );
    }
    this.byNameVersion.set(key(parsed.name, parsed.version), parsed);
  }

  async get(
    name: CapabilityName,
    version: SemVer,
  ): Promise<CapabilityContract | null> {
    return this.byNameVersion.get(key(name, version)) ?? null;
  }

  async list(manifest: CapabilityManifest): Promise<CapabilityContract[]> {
    return manifest.entries.map(e => {
      const c = this.byNameVersion.get(key(e.name, e.version));
      if (!c) {
        throw this.notFound(
          `capability not registered: ${e.name}@${e.version}`,
        );
      }
      return c;
    });
  }

  private invalid(message: string): PlatformErrorException {
    return new PlatformErrorException({
      category: 'validation',
      code: 'validation_failed',
      message,
      issues: [],
      retryable: false,
      httpStatus: 422,
    });
  }

  private notFound(message: string): PlatformErrorException {
    return new PlatformErrorException({
      category: 'not-found',
      code: 'not_found',
      message,
      issues: [],
      retryable: false,
      httpStatus: 404,
    });
  }
}
