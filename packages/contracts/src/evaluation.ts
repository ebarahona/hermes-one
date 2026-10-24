// @hermes-one/contracts — src/evaluation.ts
// Golden-conversation evaluation framework (evaluation and cost analytics): cases are
// DATA (author-time, versioned), played through the SAME single-step turn loop real turns use, scored
// against assertions; a RegressionGate blocks deployment publish on any 'required'-severity failure.
// (The contract imports DefinitionId/ContentHash/MeterKind that these types don't
// reference — omitted to satisfy noUnusedLocals.)
import {z} from 'zod';
import {TenantId, SemVer, IsoTimestamp, DeploymentRef} from './substrate.js';

/* ------------------------ GoldenConversationCase ------------------------ */

export const EvaluationAssertion = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool-called'),
    capability: z.string().min(1),
    atStepOrLater: z.number().int().nonnegative().default(0),
  }),
  z.object({kind: z.literal('tool-not-called'), capability: z.string().min(1)}),
  z.object({kind: z.literal('evidence-contains'), pattern: z.string().min(1)}), // matched against EvidenceRecord.statement
  z.object({kind: z.literal('reply-matches'), pattern: z.string().min(1)}), // matched against TurnResult.reply
  z.object({
    kind: z.literal('policy-outcome'),
    site: z.enum(['voter', 'preGate', 'postGate']),
    outcome: z.string().min(1),
  }),
  z.object({
    kind: z.literal('turn-outcome'),
    outcome: z.enum(['replied', 'handoff', 'deferred', 'no-action', 'failed']),
  }),
]);
export type EvaluationAssertion = z.infer<typeof EvaluationAssertion>;

export const GoldenConversationCase = z.object({
  caseId: z.string().min(1), // 'eval_...' — storage-only id, not a substrate-branded type
  tenantId: TenantId.nullable(), // null = platform-shared case (runs against every tenant's deployment)
  vertical: z.string().min(1).nullable(), // e.g. "electrician"; null = vertical-agnostic
  name: z.string().min(1),
  severity: z.enum(['required', 'advisory']), // 'required' blocks publish; 'advisory' reports only
  /** Scripted inbound turns, played in order against the SAME single-step loop real turns use. */
  turns: z
    .array(
      z.object({
        text: z.string(),
        attachments: z
          .array(z.object({kind: z.string(), ref: z.string()}))
          .default([]),
      }),
    )
    .min(1),
  assertions: z.array(EvaluationAssertion).min(1),
  version: SemVer,
  updatedAt: IsoTimestamp,
  updatedBy: z.string().min(1),
});
export type GoldenConversationCase = z.infer<typeof GoldenConversationCase>;

/* ------------------------------ Evaluation run --------------------------- */

export const EvaluationResult = z.object({
  caseId: z.string().min(1),
  deploymentRef: DeploymentRef,
  passed: z.boolean(),
  assertionResults: z.array(
    z.object({
      assertion: EvaluationAssertion,
      passed: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  ranAt: IsoTimestamp,
  /** Always true — evaluation runs execute via SimulationService. */
  dryRun: z.literal(true),
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;

export interface EvaluationRunner {
  /** Drives the SimulationService — does NOT reimplement the turn loop. */
  runCase(
    goldenCase: GoldenConversationCase,
    deploymentRef: DeploymentRef,
  ): Promise<EvaluationResult>;
  runSuite(
    goldenCases: GoldenConversationCase[],
    deploymentRef: DeploymentRef,
  ): Promise<EvaluationResult[]>;
}

export interface RegressionGate {
  /** Fails if any 'required'-severity case's EvaluationResult.passed is false. Consulted by deployment publish. */
  evaluate(
    results: EvaluationResult[],
    cases: GoldenConversationCase[],
  ): {pass: true} | {pass: false; reason: string; failedCaseIds: string[]};
}
