// Integration test against the live backing stack (Postgres :5433). Proves the 0015/0016 migrations apply
// and DrizzleAuditSink appends immutable audit events tenant-scoped (RLS 'strict'), idempotently on id
// (replay-safe), and reads them back through the tenant-scoped query.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import type {AuditEvent, TenantId} from '@platform/contracts';
import {runMigrations} from './migrate.js';
import {createAuditSink, type AuditSinkHandle} from './client.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_audit_itest' as TenantId;

let owner: Pool;
let audit: AuditSinkHandle;

const ev = (id: string, action: AuditEvent['action'], outcome: AuditEvent['outcome']): AuditEvent => ({
  id: id as AuditEvent['id'],
  tenantId: TENANT,
  principalId: 'prn_audit' as AuditEvent['principalId'],
  action,
  correlationId: 'trn_audit_itest',
  turnId: 'trn_audit_itest' as AuditEvent['turnId'],
  conversationId: 'cnv_audit' as AuditEvent['conversationId'],
  subject: 'appointment.slot.read',
  detail: {k: 'v'},
  outcome,
  occurredAt: '2026-07-13T00:00:00.000Z' as AuditEvent['occurredAt'],
  integrityHash: `sha256:${'a'.repeat(64)}`,
});

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  audit = createAuditSink(PG);
  await owner.query(`DELETE FROM audit.audit_events WHERE tenant_id = $1`, [TENANT]);
});

afterAll(async () => {
  await owner.query(`DELETE FROM audit.audit_events WHERE tenant_id = $1`, [TENANT]);
  await owner.end();
  await audit.close();
});

describe('DrizzleAuditSink (live)', () => {
  it('appends events tenant-scoped and reads them back through the tenant-scoped query', async () => {
    await audit.repo.append(ev('aud_it_1', 'tool.invoked', 'success'));
    await audit.repo.append(ev('aud_it_2', 'decision.policy', 'denied'));

    const all = await audit.repo.query({tenantId: TENANT});
    expect(all).toHaveLength(2);
    expect(all.every(e => e.tenantId === TENANT)).toBe(true);

    const denied = await audit.repo.query({tenantId: TENANT, action: 'decision.policy'});
    expect(denied.map(e => e.id)).toEqual(['aud_it_2']);
    expect(denied[0].outcome).toBe('denied');
    expect(denied[0].integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is idempotent on id — a replayed append collapses to one row', async () => {
    await audit.repo.append(ev('aud_it_1', 'tool.invoked', 'success'));
    const c = await owner.query(`SELECT count(*)::int AS n FROM audit.audit_events WHERE tenant_id = $1`, [TENANT]);
    expect(c.rows[0].n).toBe(2);
  });
});
