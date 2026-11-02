import {describe, expect, it} from 'vitest';
import type {DrizzleMessageRepository} from '@hermes-one/drizzle';
import type {ProviderExecutionContext, TenantId} from '@hermes-one/contracts';
import {MESSAGING_REPLY_SEND, PersistingMessageProvider} from './messaging.js';

const ctx: ProviderExecutionContext = {
  tenantId: 'tnt_acme' as TenantId,
  capability: MESSAGING_REPLY_SEND,
  idempotencyKey: 'idem-abc',
  config: {},
};

describe('PersistingMessageProvider', () => {
  it('persists the outbound row, then prints it', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const repo = {
      appendOutbound: async (row: Record<string, unknown>) => {
        rows.push(row);
      },
    } as unknown as DrizzleMessageRepository;
    const lines: string[] = [];
    const p = new PersistingMessageProvider(repo, undefined, l =>
      lines.push(l),
    );

    const out = await p.execute({to: '+15125559999', body: 'on my way'}, ctx);

    expect(out.status).toBe('queued');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({channel: 'sms', body: 'on my way'});
    expect(lines).toEqual(['[sms] to +15125559999: on my way']);
  });
});
