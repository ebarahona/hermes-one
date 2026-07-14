// @platform/contracts — the platform's canonical Zod-first contracts (ADR-020).
// Barrel, in dependency order. The single source of truth every package depends
// on; adapters implement the ports declared here.

export * from './error.js';
export * from './substrate.js';
export * from './tenant.js';
export * from './tenant-scope.js';
export * from './rule.js';
export * from './capability.js';
export * from './provider.js';
export * from './policy.js';
export * from './agent-runtime.js';
export * from './handoff.js';
export * from './audit.js';
export * from './audit-replay.js';
export * from './analytics.js';
export * from './evaluation.js';
export * from './telemetry.js';
export * from './workflow.js';
export * from './event.js';
export * from './composition-root.js';
export * from './secret.js';
export * from './role.js';

export const descriptor = {
  name: '@platform/contracts',
  role: 'package',
  plane: 'none',
  published: true,
  sourceDocs: ['contracts/'],
  governedBy: ['ADR-016', 'ADR-020'],
} as const;
