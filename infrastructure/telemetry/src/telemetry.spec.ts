import {describe, expect, it} from 'vitest';
import {correlationFromWorkspace, type LogRecord, type RedactionRule} from '@platform/contracts';
import {FieldRedactor} from './redactor.js';
import {JsonLogger, RedactingLogger} from './logger.js';

const record = (fields: Record<string, unknown>, level: LogRecord['level'] = 'info'): LogRecord => ({
  level, message: 'turn done', timestamp: '2026-07-13T00:00:00.000Z', correlation: {correlationId: 'trn_1'}, fields,
});

describe('FieldRedactor', () => {
  const rules: RedactionRule[] = [
    {fieldPath: 'reply', dataClass: 'free-text', strategy: 'mask'},
    {fieldPath: 'customer.phone', dataClass: 'contact-info', strategy: 'hash'},
    {fieldPath: 'customer.ssn', dataClass: 'direct-identifier', strategy: 'drop'},
  ];
  const redactor = new FieldRedactor(rules);

  it('masks, hashes, and drops fields by dot-path', () => {
    const out = redactor.redact(record({reply: 'see you at 9am', customer: {phone: '+15125550142', ssn: '123-45', name: 'Ada'}}));
    expect(out.fields.reply).toBe('[REDACTED]');
    expect(out.fields.customer).toMatchObject({name: 'Ada'});
    expect((out.fields.customer as {phone: string}).phone).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect((out.fields.customer as Record<string, unknown>).ssn).toBeUndefined();
  });

  it('is non-mutating and no-ops on absent paths', () => {
    const input = record({reply: 'hi'});
    const out = redactor.redact(input);
    expect(input.fields.reply).toBe('hi'); // original untouched
    expect(out.fields.reply).toBe('[REDACTED]');
    expect(out.fields.customer).toBeUndefined(); // rule for absent path is a no-op, no crash
  });

  it('hash is deterministic (correlatable without exposing the value)', () => {
    const a = redactor.redact(record({reply: '', customer: {phone: '+1555'}}));
    const b = redactor.redact(record({reply: '', customer: {phone: '+1555'}}));
    expect((a.fields.customer as {phone: string}).phone).toBe((b.fields.customer as {phone: string}).phone);
  });
});

describe('JsonLogger / RedactingLogger', () => {
  it('emits one JSON line at or above minLevel and filters below', () => {
    const lines: string[] = [];
    const logger = new JsonLogger('info', l => lines.push(l));
    logger.log(record({}, 'debug')); // filtered
    logger.log(record({a: 1}, 'warn'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({level: 'warn', message: 'turn done', fields: {a: 1}});
  });

  it('redacts before emitting', () => {
    const lines: string[] = [];
    const logger = new RedactingLogger(new JsonLogger('info', l => lines.push(l)), new FieldRedactor([{fieldPath: 'reply', dataClass: 'free-text', strategy: 'mask'}]));
    logger.log(record({reply: 'secret plan'}));
    expect(JSON.parse(lines[0]).fields.reply).toBe('[REDACTED]');
    expect(lines[0]).not.toContain('secret plan');
  });
});

describe('correlationFromWorkspace', () => {
  it('derives the correlation ids without inventing any', () => {
    const c = correlationFromWorkspace(
      {workspaceId: 'wsp_1' as never, tenantRuntime: {tenantId: 'tnt_1' as never}, conversationId: 'cnv_1' as never, correlationId: 'trn_1'},
      'trn_1' as never,
    );
    expect(c).toEqual({tenantId: 'tnt_1', workspaceId: 'wsp_1', conversationId: 'cnv_1', turnId: 'trn_1', correlationId: 'trn_1'});
  });
});
