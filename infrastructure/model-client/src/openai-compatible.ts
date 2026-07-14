// OpenAI-compatible single-step model adapter (behind the SingleStepModel port). Works with ANY
// OpenAI-compatible server — llama-server, vLLM, LM Studio, OpenAI itself, or a gateway — selected
// entirely by config (baseUrl/model/apiKey). Swapping providers is a config change; a non-OpenAI
// provider is a different adapter behind the same port.
import OpenAI from 'openai';
import type {ModelResult, SingleStepModel} from './port.js';

export interface ModelClientConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Some local "thinking" models prepend <think>…</think>; strip it defensively. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function createOpenAICompatibleModel(cfg: ModelClientConfig): SingleStepModel {
  const client = new OpenAI({baseURL: cfg.baseUrl, apiKey: cfg.apiKey});

  return {
    async complete({messages, tools}): Promise<ModelResult> {
      const params: Record<string, unknown> = {
        model: cfg.model,
        messages,
        temperature: 0, // deterministic-leaning single step
      };
      if (tools?.length) {
        params.tools = tools.map(t => ({
          type: 'function',
          function: {name: t.name, description: t.description, parameters: t.parameters},
        }));
        params.tool_choice = 'auto';
      }
      // llama-server extension (ignored by other servers): drop qwen <think>.
      params.chat_template_kwargs = {enable_thinking: false};

      const resp = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      );
      if (!resp?.choices?.length) {
        throw new Error(
          `model at ${cfg.baseUrl} returned no choices (got ${JSON.stringify(resp)?.slice(0, 200)}) — ` +
            'is the endpoint an OpenAI-compatible chat/completions server?',
        );
      }
      const msg = resp.choices[0]?.message;
      const toolCalls = (msg?.tool_calls ?? []).flatMap(tc =>
        tc.type === 'function'
          ? [{name: tc.function.name, arguments: parseArgs(tc.function.arguments)}]
          : [],
      );
      return {
        text: stripThink(msg?.content ?? ''),
        toolCalls,
        usage: {
          inputTokens: resp.usage?.prompt_tokens ?? 0,
          outputTokens: resp.usage?.completion_tokens ?? 0,
          costUsd: 0, // local/self-hosted; a priced gateway would populate this
        },
      };
    },
  };
}
