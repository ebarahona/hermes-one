// Unit-test the per-call model selection of the OpenAI-compatible adapter with the SDK client mocked
// (no network): the request's model/temperature win over the configured default.
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createOpenAICompatibleModel} from './openai-compatible.js';

const sent: Array<Record<string, unknown>> = [];

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sent.push(params);
          return {choices: [{message: {content: 'ok', tool_calls: []}}]};
        },
      },
    };
  },
}));

const model = createOpenAICompatibleModel({
  baseUrl: 'http://model.test/v1',
  model: 'config-default',
  apiKey: 'test',
});
const messages = [{role: 'user' as const, content: 'hi'}];

describe('OpenAI-compatible model adapter', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('uses the engine model over the configured default', async () => {
    await model.complete({messages, model: 'engine-model'});
    expect(sent[0]?.model).toBe('engine-model');
  });

  it('uses the configured default when the engine sets no model', async () => {
    await model.complete({messages});
    await model.complete({messages, model: ''});
    expect(sent.map(p => p.model)).toEqual([
      'config-default',
      'config-default',
    ]);
  });

  it('passes the engine temperature through, defaulting to 0', async () => {
    await model.complete({messages, temperature: 0.7});
    await model.complete({messages});
    expect(sent.map(p => p.temperature)).toEqual([0.7, 0]);
  });
});
