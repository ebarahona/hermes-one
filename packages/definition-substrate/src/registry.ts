// DefinitionRegistry (platform.definition.registry): the single entry point that drives a definition
// from authored body → validated/compiled → content-hashed → stored, up to `published`. Logic-DSL kinds
// (workflow/rule/policy) run through an injected compiler; contract-schema kinds (capability/agent-engine)
// are validate-and-pin only (ADR-016). Idempotent by contentHash: a byte-identical re-put dedupes to the
// same planId (planId is derived deterministically from the contentHash, which excludes volatile fields).
import {
  AgentEngineContract,
  CapabilityContract,
  FAMILY_OF,
  PlatformErrorException,
  SchemaRef,
  type CompiledPlanBase,
  type ContentHash,
  type Definition,
  type DefinitionId,
  type PlanId,
  type PrincipalId,
  type SemVer,
  type TenantId,
  type ValidatedContractBase,
} from '@platform/contracts';
import {contentHashOf} from './content-hash.js';
import type {DefinitionWritePort, PlanStorePort} from './ports.js';
import {definitionPublishedEvent} from './events.js';

export interface CompileDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PutDefinitionResult {
  definitionId: DefinitionId;
  planId: PlanId | null;
  contentHash: ContentHash;
  version: SemVer;
  status: 'published';
  diagnostics: CompileDiagnostic[];
}

/** A logic-DSL compiler wrapped to a uniform shape (the composition root closes over the operator registry). */
export type CompileFn = (
  def: Definition,
  ctx: {planId: PlanId; compiledAt: string; compilerVersion: SemVer},
) => CompiledPlanBase;

export interface DefinitionRegistryDeps {
  store: PlanStorePort;
  definitions: DefinitionWritePort;
  compilers: Partial<Record<'workflow' | 'rule' | 'policy', CompileFn>>;
  compilerVersion: SemVer;
  /** Injected clock (activity/composition context; keeps put() pure for tests). */
  now: () => string;
}

const planIdFromHash = (h: ContentHash): PlanId =>
  `pln_${h.replace('sha256:', '').slice(0, 24)}` as PlanId;

/** Zod failure → the typed validation error the admin API projects to 422 (error contracts). */
const validationFailed = (
  message: string,
  issues: {path: (string | number | symbol)[]; message: string}[],
): PlatformErrorException =>
  new PlatformErrorException({
    category: 'validation',
    code: 'validation_failed',
    message,
    issues: issues.map(i => ({
      path: `/${i.path.map(String).join('/')}`,
      message: i.message,
    })),
    retryable: false,
    httpStatus: 422,
  });

export class DefinitionRegistry {
  constructor(private readonly deps: DefinitionRegistryDeps) {}

  async put(def: Definition, actor: PrincipalId): Promise<PutDefinitionResult> {
    const tenantId = def.tenantId as TenantId;
    if (!tenantId) {
      // Platform-shared (tenant_id IS NULL) definitions require a privileged path;
      // not minted through platform_app here (flagged).
      throw new Error(
        'DefinitionRegistry.put requires a tenant-scoped definition (tenantId set)',
      );
    }
    const scope = {tenantId};
    // Assert the SchemaRef grammar `<name>.<type>/vN` before the family branch.
    const schemaRef = SchemaRef.safeParse(def.schemaRef);
    if (!schemaRef.success) {
      throw validationFailed(
        `definition '${def.definitionId}' has an invalid schemaRef '${String(def.schemaRef)}' (expected "<name>.<type>/vN")`,
        [{path: ['schemaRef'], message: 'expected "<name>.<type>/vN"'}],
      );
    }
    const family = FAMILY_OF[def.kind];
    const at = this.deps.now();

    if (family === 'logic-dsl') {
      const compile =
        this.deps.compilers[def.kind as 'workflow' | 'rule' | 'policy'];
      if (!compile)
        throw new Error(`no compiler registered for kind '${def.kind}'`);

      // Compile once with a provisional planId to obtain the contentHash (which excludes planId), then
      // pin the deterministic planId derived from it.
      const provisional = compile(def, {
        planId: 'pln_provisional' as PlanId,
        compiledAt: at,
        compilerVersion: this.deps.compilerVersion,
      });
      const contentHash = provisional.contentHash;
      const planId = planIdFromHash(contentHash);
      const plan: CompiledPlanBase = {...provisional, planId};
      const byteSize = JSON.stringify(plan).length;

      // Authoring identity + version FIRST — compiled_plans.definition_id has an FK to definitions.
      await this.deps.definitions.putDefinition(
        {
          definitionId: def.definitionId,
          kind: def.kind,
          name: def.name,
          schemaRef: def.schemaRef,
          currentVersion: def.version,
          status: 'published',
          labels: def.labels,
          createdBy: actor,
        },
        {
          definitionId: def.definitionId,
          version: def.version,
          contentHash,
          family,
          status: 'published',
          body: def.body,
          compilerVersion: this.deps.compilerVersion,
          diagnostics: [],
          createdBy: actor,
        },
        scope,
      );
      await this.deps.store.putCompiledPlan(plan, byteSize);
      return {
        definitionId: def.definitionId,
        planId,
        contentHash,
        version: def.version,
        status: 'published',
        diagnostics: [],
      };
    }

    // contract-schema (capability | agent-engine): validate-and-pin only, no compiler.
    const core = {
      kind: def.kind,
      definitionId: def.definitionId,
      version: def.version,
      schemaRef: def.schemaRef,
      body: def.body,
    };
    const contentHash = contentHashOf(core);
    const base = {
      definitionId: def.definitionId,
      kind: def.kind,
      version: def.version,
      contentHash,
      validatedAt: at,
      schemaRef: def.schemaRef,
    };
    // agent-engine keeps its config under `body` (AgentEngineContract); capability spreads its fields
    // at the top level (CapabilityContract) — the two contract-schema shapes differ (agent-runtime /
    // capability). Validate against the canonical versioned Zod schema — "validate only
    // (Zod, no compiler)" (ADR-016); a failing body never reaches the store.
    const parsed =
      def.kind === 'agent-engine'
        ? AgentEngineContract.safeParse({...base, body: def.body})
        : CapabilityContract.safeParse({
            ...base,
            ...(def.body as Record<string, unknown>),
          });
    if (!parsed.success) {
      throw validationFailed(
        `${def.kind} contract body failed schema validation`,
        parsed.error.issues,
      );
    }
    const contract: ValidatedContractBase = parsed.data;

    // definition.published fires for kind:'capability' ONLY (the event's trigger
    // column); it rides putDefinition's transaction and is skipped on an idempotent re-put.
    const events =
      def.kind === 'capability'
        ? [
            definitionPublishedEvent({
              tenantId,
              actor,
              definitionId: def.definitionId,
              name: def.name,
              version: def.version,
              contentHash,
              occurredAt: at as never,
            }),
          ]
        : [];

    // Authoring identity + version FIRST — validated_contracts.definition_id has an FK to definitions.
    await this.deps.definitions.putDefinition(
      {
        definitionId: def.definitionId,
        kind: def.kind,
        name: def.name,
        schemaRef: def.schemaRef,
        currentVersion: def.version,
        status: 'published',
        labels: def.labels,
        createdBy: actor,
      },
      {
        definitionId: def.definitionId,
        version: def.version,
        contentHash,
        family,
        status: 'published',
        body: def.body,
        compilerVersion: null,
        diagnostics: [],
        createdBy: actor,
      },
      scope,
      events,
    );
    await this.deps.store.putValidatedContract(contract);
    return {
      definitionId: def.definitionId,
      planId: null,
      contentHash,
      version: def.version,
      status: 'published',
      diagnostics: [],
    };
  }
}
