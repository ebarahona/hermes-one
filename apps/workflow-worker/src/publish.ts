// Demo publish path: migrate the schema, seed the authoring `definitions` rows (the FK compiled_plans
// requires), and store each compiled plan content-addressed. In production this is the
// DefinitionRegistry.put / DeploymentService.publish pipeline; here it puts the two demo plans so a
// workflow started with only refs can load them hash-verified via the plan-load activity (ADR-014).
// Kept out of bundle.ts because bundle.ts is type-imported into the Temporal deterministic sandbox.
import {
  createCompiledPlanStore,
  createMigratorDb,
  createSubstrateWrite,
  runMigrations,
} from '@platform-internal/drizzle';
import {builtinRegistry} from '@platform/expression-core';
import {compileRule} from '@platform/rule-dsl';
import {compileWorkflow} from '@platform/workflow-dsl';
import {compilePolicy} from '@platform/policy-dsl';
import {
  DefinitionRegistry,
  DeploymentService,
  type CompileFn,
} from '@platform/definition-substrate';
import {ExpressionPolicyRuntime} from '@platform/policy-dsl';
import {composeCandidateRegressionCheck} from '@platform-internal/evaluation';
import type {Decider} from '@platform-internal/agent-runtime';
import type {
  ContentHash,
  Definition,
  DefinitionId,
  DeploymentMember,
  DeploymentRef,
  GoldenConversationCase,
  IsoTimestamp,
  PlanId,
  PrincipalId,
  SemVer,
  TenantId,
  ToolCall,
} from '@platform/contracts';
import type {RunBundle} from './bundle.js';

export const E2E_TENANT = 'tnt_e2e';

export async function publishBundle(
  bundle: RunBundle,
  pgUrl: string,
  redisUrl: string,
  tenantId: string = E2E_TENANT,
): Promise<void> {
  await runMigrations(pgUrl);

  // definitions rows (compiled_plans.definition_id FK). Seeded by the privileged/owner connection.
  const owner = createMigratorDb(pgUrl);
  try {
    for (const plan of [bundle.workflowPlan, bundle.rulePlan]) {
      await owner.pool.query(
        `INSERT INTO substrate.definitions
           (definition_id, tenant_id, kind, name, schema_ref, current_version, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'published', 'prn_seed')
         ON CONFLICT (definition_id) DO NOTHING`,
        [
          plan.definitionId,
          tenantId,
          plan.kind,
          plan.definitionId,
          `e2e.${plan.kind}/v1`,
          plan.version,
        ],
      );
    }
  } finally {
    await owner.close();
  }

  // Content-addressed plan store (as platform_app).
  const {store, close} = createCompiledPlanStore(pgUrl, redisUrl);
  try {
    await store.putCompiledPlan(
      bundle.workflowPlan,
      JSON.stringify(bundle.workflowPlan).length,
    );
    await store.putCompiledPlan(
      bundle.rulePlan,
      JSON.stringify(bundle.rulePlan).length,
    );
  } finally {
    await close();
  }
}

const V1 = '1.0.0' as SemVer;
const ACTOR = 'prn_e2e' as PrincipalId;
const AT = '2026-07-12T00:00:00.000Z';

/**
 * The golden case gating this publish (OB6): a complex booking request MUST consult the scheduler
 * (appointment.slot.read) before replying — the behavioral contract of the triage deployment.
 */
const goldenBookingCase: GoldenConversationCase = {
  caseId: 'eval_booking_slot_read',
  tenantId: null,
  vertical: null,
  name: 'complex booking consults the scheduler before replying',
  severity: 'required',
  turns: [{text: 'I need to reschedule my appointment', attachments: []}],
  assertions: [
    {
      kind: 'tool-called',
      capability: 'appointment.slot.read',
      atStepOrLater: 0,
    },
    {kind: 'turn-outcome', outcome: 'replied'},
    {kind: 'reply-matches', pattern: '9am|slot'},
  ],
  version: V1,
  updatedAt: AT as IsoTimestamp,
  updatedBy: ACTOR,
} as GoldenConversationCase;

/** The scripted mock model for the golden case: consult the scheduler, then reply from evidence. */
const goldenBookingScript = (): Decider => ({
  propose: step =>
    step === 0
      ? {
          kind: 'tool',
          call: {
            toolCallId: 'tc_gate_0',
            capability: 'appointment.slot.read',
            input: {date: '2026-07-15'},
            idempotencyKey: 'idem_gate_0',
            proposedAt: AT,
          } as unknown as ToolCall,
          usage: {inputTokens: 10, outputTokens: 5, costUsd: 0},
        }
      : {
          kind: 'done',
          reply: 'You are booked for 9am.',
          usage: {inputTokens: 4, outputTokens: 6, costUsd: 0},
        },
});

const authored = (
  id: string,
  kind: Definition['kind'],
  name: string,
  body: unknown,
  tenantId: string,
): Definition =>
  ({
    definitionId: id,
    tenantId,
    kind,
    name,
    schemaRef: `${name}.${kind}/v1`,
    version: V1,
    status: 'draft',
    labels: {},
    createdAt: AT,
    updatedAt: AT,
    createdBy: ACTOR,
    body,
  }) as unknown as Definition;

/**
 * Publish a real active deployment for the triage tenant so the agent turn resolves its engine,
 * capabilities, and policy from it (deployment-driven runtime). The workflow + rule are referenced
 * from the already-published bundle plans; the policy, agent-engine, and capability are authored here
 * through DefinitionRegistry and pinned together by DeploymentService.publish.
 */
export async function publishAgentDeployment(
  bundle: RunBundle,
  pgUrl: string,
  redisUrl: string,
  tenantId: string = E2E_TENANT,
): Promise<DeploymentRef> {
  await runMigrations(pgUrl);
  const {store, close: closeStore} = createCompiledPlanStore(pgUrl, redisUrl);
  const write = createSubstrateWrite(pgUrl);
  const opreg = builtinRegistry(V1);
  const compilers: Record<'workflow' | 'rule' | 'policy', CompileFn> = {
    workflow: (def, ctx) =>
      compileWorkflow(def as never, {
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
    rule: (def, ctx) =>
      compileRule(def as never, {
        registry: opreg,
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
    policy: (def, ctx) =>
      compilePolicy(def as never, {
        registry: opreg,
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
  };
  const registry = new DefinitionRegistry({
    store,
    definitions: write.definitions,
    compilers,
    compilerVersion: V1,
    now: () => AT,
  });

  try {
    // Permissive policy: a single preGate that never fires → all gates allow.
    const pol = await registry.put(
      authored(
        'def_e2e_policy',
        'policy',
        'permissive',
        {
          rules: [
            {
              id: 'noop',
              site: 'preGate',
              appliesTo: [],
              when: {type: 'literal', value: false},
              effect: 'deny',
              reason: 'noop',
            },
          ],
          defaultVoterVerdict: 'deny',
          parameters: [],
        },
        tenantId,
      ),
      ACTOR,
    );
    // The capability the engine may use — a real agentback @tool (appointment.slot.read).
    const cap = await registry.put(
      authored(
        'def_e2e_slot_read',
        'capability',
        'appointment-slot-read',
        {
          name: 'appointment.slot.read',
          title: 'Read appointment slots',
          description: 'List open appointment slots for a given date.',
          inputJsonSchema: {
            type: 'object',
            required: ['date'],
            properties: {date: {type: 'string'}},
          },
          outputJsonSchema: {
            type: 'object',
            properties: {slots: {type: 'array'}},
          },
          sideEffect: 'read',
          changedDomains: ['none'],
          idempotency: {required: false, keyFields: [], ttlSeconds: 86400},
          confirm: false,
          requiredScope: 'appointment.slot.read',
          providerMapping: {
            providers: [{providerId: 'internal-scheduler', priority: 100}],
            eligibility: [],
            onNoProvider: 'fail',
          },
        },
        tenantId,
      ),
      ACTOR,
    );
    const eng = await registry.put(
      authored(
        'def_e2e_engine',
        'agent-engine',
        'assistant',
        {
          persona: 'A concise scheduling assistant.',
          objectives: ['help the customer reschedule'],
          allowedCapabilities: ['appointment.slot.read'],
          referencedRules: [],
          model: {provider: 'local', model: 'x', temperature: 0},
          promptTemplateIds: [],
        },
        tenantId,
      ),
      ACTOR,
    );

    const m = (
      kind: DeploymentMember['kind'],
      definitionId: string,
      planId: PlanId | null,
      contentHash: string,
    ): DeploymentMember =>
      ({
        kind,
        definitionId,
        planId,
        version: V1,
        contentHash,
      }) as DeploymentMember;

    // OB6: the REAL regression gate — the candidate's own engine/capabilities/policy are loaded from
    // the substrate (already content-addressed; the deployment row doesn't exist yet) and the golden
    // suite runs through the ONE turn loop against the mock provider plane. A required-case failure
    // ABORTS the publish before anything is written. (Composed at this host — the admin-api owns the
    // production composition later; the workflow-level Temporal simulation remains deferred.)
    const regressionCheck = composeCandidateRegressionCheck({
      members: {
        tenantId: tenantId as TenantId,
        agentEngine: {
          definitionId: 'def_e2e_engine' as DefinitionId,
          contentHash: eng.contentHash as ContentHash,
        },
        policy: {
          planId: pol.planId as PlanId,
          contentHash: pol.contentHash as ContentHash,
        },
        capabilities: [
          {
            definitionId: 'def_e2e_slot_read' as DefinitionId,
            contentHash: cap.contentHash as ContentHash,
          },
        ],
      },
      loadContract: (t, d, h) => store.resolveContractCached(t, d, h),
      loadPlan: (t, p, h) => store.resolvePlanCached(t, p, h),
      policyRuntime: new ExpressionPolicyRuntime(opreg),
      suite: [goldenBookingCase],
      script: () => goldenBookingScript(),
      toolOutput: () => ({slots: ['9am']}),
    });
    const service = new DeploymentService({
      store,
      deployments: write.deployments,
      now: () => AT,
      regressionCheck: async candidate => {
        const gate = await regressionCheck(candidate);
        console.log(
          gate.pass
            ? `regression gate PASSED for ${candidate.deploymentId} (golden: ${goldenBookingCase.caseId})`
            : `regression gate BLOCKED ${candidate.deploymentId}: ${gate.reason}`,
        );
        return gate;
      },
    });

    return await service.publish({
      tenantId: tenantId as TenantId,
      workflow: m(
        'workflow',
        bundle.workflowPlan.definitionId,
        bundle.workflowPlan.planId,
        bundle.workflowPlan.contentHash,
      ),
      agentEngine: m('agent-engine', 'def_e2e_engine', null, eng.contentHash),
      policy: m('policy', 'def_e2e_policy', pol.planId, pol.contentHash),
      rules: [
        m(
          'rule',
          bundle.rulePlan.definitionId,
          bundle.rulePlan.planId,
          bundle.rulePlan.contentHash,
        ),
      ],
      capabilities: [
        m('capability', 'def_e2e_slot_read', null, cap.contentHash),
      ],
      operatorRegistryVersion: V1,
      actor: ACTOR,
    });
  } finally {
    await write.close();
    await closeStore();
  }
}
