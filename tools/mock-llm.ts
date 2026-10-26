// mock-llm: a scripted, OpenAI-compatible chat server for running the agent tests without a real
// model. Point LLM_BASE_URL at it and the agent worker talks to it through the normal model client.
//
//   pnpm mock-llm                          # listens on 127.0.0.1:4010 (MOCK_LLM_HOST/PORT to change)
//   LLM_BASE_URL=http://127.0.0.1:4010/v1 LLM_MODEL=mock LLM_API_KEY=mock node apps/agent-worker/dist/e2e.js
//
// It answers the way the platform's single-step decider expects:
//   - first step, tools offered, and the customer's message asks about scheduling or names a date: call the
//     slot tool (or the first tool) with its required arguments filled in
//   - a "Results so far: ..." step (after a tool ran): a short final reply quoting the results
//   - anything else: a short, polite final reply with no tool call
// The replies are fixed text, so runs are deterministic. This proves the platform's plumbing (routing,
// tool dispatch, policy gates, persistence, delivery), not the quality of a real model's answers.
import {createServer, type IncomingMessage} from 'node:http';

interface ChatTool {
  type: 'function';
  function: {
    name: string;
    parameters?: {required?: string[]; properties?: Record<string, unknown>};
  };
}
interface ChatRequest {
  model?: string;
  messages?: {role: string; content?: string}[];
  tools?: ChatTool[];
}

const SCHEDULING =
  /\b(slot|slots|availab\w*|appointment\w*|schedule\w*|scheduling|book\w*)\b/i;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;

function argumentsFor(tool: ChatTool, text: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const key of tool.function.parameters?.required ?? []) {
    args[key] = /date/i.test(key)
      ? (text.match(DATE)?.[0] ?? '2026-01-05')
      : 'general';
  }
  return args;
}

export function respond(req: ChatRequest): {
  content: string | null;
  toolCall?: {name: string; arguments: Record<string, string>};
} {
  const messages = req.messages ?? [];
  const user =
    [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  // The decider sends the objective with the customer's message appended as "(inbound: ...)". Only
  // the customer's message decides the route, so words in the objective never trigger a tool call.
  const context = user.match(/\(inbound: ([\s\S]*)\)\s*$/)?.[1] ?? user;

  if (user.startsWith('Results so far:')) {
    const results = user
      .slice('Results so far:'.length)
      .replace(/\. Continue or finish\.$/, '');
    return {
      content: `Here is what I found:${results}. Reply here if one of these works for you.`,
    };
  }

  const tools = req.tools ?? [];
  if (tools.length && (SCHEDULING.test(context) || DATE.test(context))) {
    const tool = tools.find(t => /slot/i.test(t.function.name)) ?? tools[0]!;
    return {
      content: null,
      toolCall: {
        name: tool.function.name,
        arguments: argumentsFor(tool, context),
      },
    };
  }

  return {
    content:
      'Thanks for reaching out. I have noted the details of your message, and a member of our team ' +
      'will follow up with you shortly.',
  };
}

async function readJson(req: IncomingMessage): Promise<ChatRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(
    Buffer.concat(chunks).toString('utf8') || '{}',
  ) as ChatRequest;
}

function startServer(port: number): void {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        return send(200, {
          object: 'list',
          data: [{id: 'mock', object: 'model'}],
        });
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        return send(404, {
          error: {message: `mock-llm: no route for ${req.method} ${req.url}`},
        });
      }
      const body = await readJson(req);
      const out = respond(body);
      calls += 1;
      const promptChars = (body.messages ?? []).reduce(
        (n, m) => n + (m.content?.length ?? 0),
        0,
      );
      return send(200, {
        id: `chatcmpl-mock-${calls}`,
        object: 'chat.completion',
        created: 0,
        model: body.model ?? 'mock',
        choices: [
          {
            index: 0,
            finish_reason: out.toolCall ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: out.content,
              ...(out.toolCall
                ? {
                    tool_calls: [
                      {
                        id: `call_mock_${calls}`,
                        type: 'function',
                        function: {
                          name: out.toolCall.name,
                          arguments: JSON.stringify(out.toolCall.arguments),
                        },
                      },
                    ],
                  }
                : {}),
            },
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(promptChars / 4),
          completion_tokens: Math.ceil((out.content?.length ?? 40) / 4),
        },
      });
    } catch (err) {
      return send(400, {error: {message: `mock-llm: ${String(err)}`}});
    }
  });
  const host = process.env.MOCK_LLM_HOST ?? '127.0.0.1'; // 0.0.0.0 inside a container
  server.listen(port, host, () => {
    console.log(`mock-llm listening on http://${host}:${port}/v1`);
  });
}

if (process.argv[1] && /mock-llm\.[cm]?[jt]s$/.test(process.argv[1])) {
  startServer(Number(process.env.MOCK_LLM_PORT ?? 4010));
}
