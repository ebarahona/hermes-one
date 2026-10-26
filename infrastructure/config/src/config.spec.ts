import {describe, expect, it} from 'vitest';
import {loadConfig} from './config.js';

describe('loadConfig: admin auth and gateway routing', () => {
  it('defaults to no admin keys, no OIDC issuers, and no gateway numbers', () => {
    const cfg = loadConfig({});
    expect(cfg.api.apiKeys).toEqual([]);
    expect(cfg.api.oidcIssuers).toEqual([]);
    expect(cfg.gateway).toEqual({
      host: '127.0.0.1',
      port: 3002,
      numbers: {},
      ruleParameters: {},
    });
  });

  it('parses the JSON-valued variables', () => {
    const cfg = loadConfig({
      HERMES_ADMIN_API_KEYS: JSON.stringify([
        {
          key: 'a-key-of-at-least-16',
          keyId: 'apk_1',
          tenantId: 'tnt_a',
          principalId: 'prn_a',
          scopes: ['deployment.read'],
        },
      ]),
      HERMES_OIDC_ISSUERS: JSON.stringify([
        {
          issuer: 'https://idp.example',
          audience: 'hermes',
          jwksUri: 'https://idp.example/jwks',
        },
      ]),
      HERMES_GATEWAY_NUMBERS: '{"+15125550100":"tnt_a"}',
      HERMES_RULE_PARAMETERS: '{"tnt_a":{"serviceZips":["75001"]}}',
    });
    expect(cfg.api.apiKeys[0]?.tenantId).toBe('tnt_a');
    expect(cfg.api.oidcIssuers[0]?.jwksUri).toBe('https://idp.example/jwks');
    expect(cfg.gateway.numbers['+15125550100']).toBe('tnt_a');
    expect(cfg.gateway.ruleParameters.tnt_a).toEqual({serviceZips: ['75001']});
  });

  it('treats an empty JSON variable as its default (a copied .env.example)', () => {
    const cfg = loadConfig({
      HERMES_ADMIN_API_KEYS: '',
      HERMES_GATEWAY_NUMBERS: '',
    });
    expect(cfg.api.apiKeys).toEqual([]);
    expect(cfg.gateway.numbers).toEqual({});
  });

  it('names the variable when its JSON is malformed', () => {
    expect(() => loadConfig({HERMES_GATEWAY_NUMBERS: '{oops'})).toThrow(
      'HERMES_GATEWAY_NUMBERS is not valid JSON',
    );
  });

  it('rejects an admin key shorter than 16 characters (fail-closed)', () => {
    expect(() =>
      loadConfig({
        HERMES_ADMIN_API_KEYS:
          '[{"key":"short","keyId":"k","tenantId":"t","principalId":"p","scopes":[]}]',
      }),
    ).toThrow();
  });
});
