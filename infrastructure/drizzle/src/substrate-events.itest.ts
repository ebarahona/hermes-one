// Live-PG proof of the ATOMIC substrate writer (Phase 2b — "F3 for the substrate path"):
// putDefinition/publish commit their rows AND the audit event AND its outbox envelope in ONE
// transaction. The three assertions that matter:
//   1. a publish leaves all three rows (domain + audit + outbox) — never a subset;
//   2. an idempotent re-put emits NOTHING new (exactly-once, the billing rule);
//   3. a POISONED event (audit tamper-reject fires in-tx) rolls the DOMAIN row back too — a crash or
//      refusal mid-write leaves no published version without its audit trail.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import type {IsoTimestamp, PrincipalId, TenantId} from '@hermes-one/contracts';
import {
  definitionPublishedEvent,
  deploymentPublishedEvent,
} from '@hermes-one/definition-substrate';
import {runMigrations} from './migrate.js';
import {createSubstrateWrite, type SubstrateWriteHandle} from './client.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_subev_itest' as TenantId;
const ACTOR = 'prn_subev' as PrincipalId;
const NOW = '2026-07-17T00:00:00.000Z' as IsoTimestamp;

let owner: Pool;
let write: SubstrateWriteHandle;

const defRow = (id: string, version: string) => ({
  definitionId: id,
  kind: 'capability' as const,
  name: `cap.${id}`, // definitions are per-tenant unique on name — one name per test definition
  schemaRef: 'appointment-slot-read.capability/v1',
  currentVersion: version,
  status: 'published' as const,
  labels: {},
  createdBy: ACTOR,
});
const versionRow = (id: string, version: string) => ({
  definitionId: id,
  version,
  contentHash: `sha256:${'d'.repeat(64)}`,
  family: 'contract-schema' as const,
  status: 'published' as const,
  body: {name: 'appointment.slot.read'},
  compilerVersion: null,
  diagnostics: [],
  createdBy: ACTOR,
});
const event = (id: string, version: string) =>
  definitionPublishedEvent({
    tenantId: TENANT,
    actor: ACTOR,
    definitionId: id,
    name: `cap.${id}`,
    version,
    contentHash: `sha256:${'d'.repeat(64)}`,
    occurredAt: NOW,
  });

async function counts(correlationId: string) {
  const audit = await owner.query(
    `SELECT count(*)::int AS n FROM audit.audit_events WHERE tenant_id = $1 AND correlation_id = $2`,
    [TENANT, correlationId],
  );
  const outbox = await owner.query(
    `SELECT count(*)::int AS n FROM event.event_outbox WHERE tenant_id = $1`,
    [TENANT],
  );
  return {audit: audit.rows[0].n, outbox: outbox.rows[0].n};
}

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  write = createSubstrateWrite(PG);
  for (const sql of [
    `DELETE FROM event.event_outbox WHERE tenant_id = $1`,
    `DELETE FROM audit.audit_events WHERE tenant_id = $1`,
    `DELETE FROM substrate.deployment_members WHERE deployment_id IN (SELECT deployment_id FROM substrate.deployments WHERE tenant_id = $1)`,
    `DELETE FROM substrate.deployments WHERE tenant_id = $1`,
    `DELETE FROM substrate.definitions WHERE tenant_id = $1`,
  ])
    await owner.query(sql, [TENANT]);
  await owner.query(
    `DELETE FROM substrate.definition_versions WHERE definition_id LIKE 'def_subev%'`,
  );
});

afterAll(async () => {
  await owner.query(`DELETE FROM event.event_outbox WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.query(`DELETE FROM audit.audit_events WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.query(
    `DELETE FROM substrate.deployment_members WHERE deployment_id IN (SELECT deployment_id FROM substrate.deployments WHERE tenant_id = $1)`,
    [TENANT],
  );
  await owner.query(`DELETE FROM substrate.deployments WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.query(
    `DELETE FROM substrate.definition_versions WHERE definition_id LIKE 'def_subev%'`,
    [],
  );
  await owner.query(`DELETE FROM substrate.definitions WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.end();
  await write.close();
});

describe('atomic substrate writer (live PG)', () => {
  it('putDefinition commits row + audit + outbox together, exactly once across an idempotent re-put', async () => {
    const e = event('def_subev_1', '1.0.0');
    const first = await write.definitions.putDefinition(
      defRow('def_subev_1', '1.0.0'),
      versionRow('def_subev_1', '1.0.0'),
      {tenantId: TENANT},
      [e],
    );
    expect(first.versionInserted).toBe(true);
    expect(await counts(`def_subev_1@1.0.0`)).toEqual({audit: 1, outbox: 1});

    // Idempotent re-put: same version, same derived event → NOTHING new.
    const again = await write.definitions.putDefinition(
      defRow('def_subev_1', '1.0.0'),
      versionRow('def_subev_1', '1.0.0'),
      {tenantId: TENANT},
      [event('def_subev_1', '1.0.0')],
    );
    expect(again.versionInserted).toBe(false);
    expect(await counts(`def_subev_1@1.0.0`)).toEqual({audit: 1, outbox: 1});
  });

  it('a POISONED event rolls back the definition version row (no version without its audit trail)', async () => {
    // Poison: occupy the event's id with DIFFERENT content — the audit sink's tamper-reject fires
    // INSIDE putDefinition's transaction.
    const e = event('def_subev_2', '1.0.0');
    await owner.query(
      `INSERT INTO audit.audit_events (id, tenant_id, principal_id, action, correlation_id, subject, detail, outcome, occurred_at, integrity_hash)
       VALUES ($1, $2, $3, 'definition.published', 'poison', 'poison', '{}', 'success', now(), $4)`,
      [e.id, TENANT, ACTOR, `sha256:${'e'.repeat(64)}`],
    );

    await expect(
      write.definitions.putDefinition(
        defRow('def_subev_2', '1.0.0'),
        versionRow('def_subev_2', '1.0.0'),
        {tenantId: TENANT},
        [e],
      ),
    ).rejects.toMatchObject({error: {code: 'idempotency_conflict'}});

    // THE atomicity assertion: the version row must NOT exist.
    const v = await owner.query(
      `SELECT count(*)::int AS n FROM substrate.definition_versions WHERE definition_id = 'def_subev_2'`,
    );
    expect(v.rows[0].n).toBe(0);
  });

  it('deployment publish commits deployment + members + audit + outbox together; poison rolls back ALL', async () => {
    const dep = (v: string) => ({
      deploymentId: `dpl_subev_${v.replace(/\./g, '')}`,
      version: v,
      operatorRegistryVersion: '1.0.0',
      createdBy: ACTOR,
    });
    const member = {
      kind: 'capability' as const,
      seq: 0,
      definitionId: 'def_subev_1',
      planId: null,
      version: '1.0.0',
      contentHash: `sha256:${'d'.repeat(64)}`,
    };
    const ev = (v: string) =>
      deploymentPublishedEvent({
        tenantId: TENANT,
        actor: ACTOR,
        deploymentId: `dpl_subev_${v.replace(/\./g, '')}`,
        version: v,
        operatorRegistryVersion: '1.0.0',
        memberCount: 1,
        occurredAt: NOW,
      });

    await write.deployments.publish(
      dep('1.0.0'),
      [member],
      {tenantId: TENANT},
      [ev('1.0.0')],
    );
    const ok = await owner.query(
      `SELECT count(*)::int AS n FROM audit.audit_events WHERE tenant_id = $1 AND action = 'deployment.published'`,
      [TENANT],
    );
    expect(ok.rows[0].n).toBe(1);

    // Poison the NEXT publish's event id.
    const poisoned = ev('1.0.1');
    await owner.query(
      `INSERT INTO audit.audit_events (id, tenant_id, principal_id, action, correlation_id, subject, detail, outcome, occurred_at, integrity_hash)
       VALUES ($1, $2, $3, 'deployment.published', 'poison', 'poison', '{}', 'success', now(), $4)`,
      [poisoned.id, TENANT, ACTOR, `sha256:${'f'.repeat(64)}`],
    );
    await expect(
      write.deployments.publish(dep('1.0.1'), [member], {tenantId: TENANT}, [
        poisoned,
      ]),
    ).rejects.toMatchObject({
      error: {code: 'idempotency_conflict'},
    });

    // Rolled back: no 1.0.1 deployment row, AND 1.0.0 must still be the untouched active one —
    // the supersede UPDATE inside the failed transaction must have rolled back with it.
    const d = await owner.query(
      `SELECT version, status FROM substrate.deployments WHERE tenant_id = $1 ORDER BY version`,
      [TENANT],
    );
    expect(d.rows).toEqual([{version: '1.0.0', status: 'active'}]);
  });
});
