import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from '../src/agent/loop.js';
import { tool, toolOutput } from '../src/agent/tool.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { AssetInput } from '../src/types/images.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const shown: AssetInput = { location: { kind: 'bytes', data: png }, mimeType: 'image/png' };
const stored: AssetInput = {
  location: { kind: 'stored', assetId: 'asset-7', uri: 's3://renders/asset-7.png' },
  mimeType: 'image/png',
  filename: 'chart.png',
};

/** A conversation with one turn of two parallel tool calls, the second returning an image. */
function conversation(): Message[] {
  return [
    { role: 'user', content: 'Chart the sales and save it.' },
    {
      role: 'assistant',
      content: 'Drawing it now.',
      toolCalls: [
        { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"year":2026}' } },
        { id: 'call-2', type: 'function', function: { name: 'render', arguments: '{"kind":"bar"}' } },
      ],
    },
    { role: 'tool', toolCallId: 'call-1', content: '{"total":42}' },
    {
      role: 'tool',
      toolCallId: 'call-2',
      content: toolOutput(
        'Rendered and stored.',
        { type: 'asset', asset: stored },
        { type: 'image', source: { asset: shown } },
      ).content,
    },
    { role: 'user', content: 'Thanks.' },
  ];
}

const request = (model: string): CompletionRequest => ({ model, messages: conversation() });
const base64 = Buffer.from(png).toString('base64');

test('OpenAI chat sends tool calls and results under their ids, and a tool image after the results', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test' });
  let params: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        async create(sent: Record<string, unknown>) {
          params = sent;
          return { model: 'gpt-4o', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
        },
      },
    },
  };
  await provider.complete(request('gpt-4o'));

  const messages = params.messages as Array<Record<string, unknown>>;
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'tool', 'user', 'user'],
  );
  assert.equal((messages[1]?.tool_calls as unknown[] | undefined)?.length, 2);
  assert.equal(messages[1]?.content, 'Drawing it now.');
  assert.equal(messages[2]?.tool_call_id, 'call-1');
  assert.equal(messages[3]?.tool_call_id, 'call-2');
  const result = String(messages[3]?.content);
  assert.match(result, /stored as asset-7 at s3:\/\/renders\/asset-7\.png/);
  assert.doesNotMatch(result, new RegExp(base64.slice(0, 8)), 'no base64 in the tool result');
  const images = messages[4]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(images[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } });
  assert.equal(messages[5]?.content, 'Thanks.');
});

test('OpenAI Responses sends function_call and function_call_output items', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test' });
  let params: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    responses: {
      async create(sent: Record<string, unknown>) {
        params = sent;
        return { model: 'gpt-5.6-sol', output_text: 'done', status: 'completed', output: [] };
      },
    },
  };
  await provider.complete(request('gpt-5.6-sol'));

  const input = params.input as Array<Record<string, unknown>>;
  assert.deepEqual(
    input.filter((item) => item.type === 'function_call').map((item) => [item.call_id, item.name]),
    [
      ['call-1', 'lookup'],
      ['call-2', 'render'],
    ],
  );
  const outputs = input.filter((item) => item.type === 'function_call_output');
  assert.deepEqual(
    outputs.map((item) => item.call_id),
    ['call-1', 'call-2'],
  );
  assert.match(String(outputs[1]?.output), /asset-7/);
  const imageTurn = input.find(
    (item) =>
      Array.isArray(item.content) &&
      (item.content as Array<{ type: string }>).some((part) => part.type === 'input_image'),
  );
  assert.ok(imageTurn, 'the tool image follows the results');
});

test('Anthropic sends tool_use blocks and every result of a turn in one tool_result message', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test' });
  let params: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    messages: {
      async create(sent: Record<string, unknown>) {
        params = sent;
        return {
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: {},
        };
      },
    },
  };
  await provider.complete(request('claude-sonnet-5-5'));

  const messages = params.messages as Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'user', 'user'],
  );
  const assistant = messages[1]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(assistant[1], { type: 'tool_use', id: 'call-1', name: 'lookup', input: { year: 2026 } });
  const results = messages[2]?.content as Array<{
    type: string;
    tool_use_id: string;
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(
    results.map((block) => [block.type, block.tool_use_id]),
    [
      ['tool_result', 'call-1'],
      ['tool_result', 'call-2'],
    ],
  );
  const rendered = results[1]?.content ?? [];
  assert.match(String(rendered[1]?.text), /asset-7/);
  assert.deepEqual(rendered[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
});

test('Google sends functionCall and named functionResponse parts, and returns images it produced as assets', async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Here it is.' }, { inlineData: { mimeType: 'image/png', data: base64 } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  let response: NexusResponse;
  try {
    response = await new GoogleProvider({ apiKey: 'test' }).complete(request('gemini-3-pro-image'));
  } finally {
    globalThis.fetch = original;
  }

  const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  assert.deepEqual(
    contents.map((content) => content.role),
    ['user', 'model', 'user', 'user'],
  );
  assert.deepEqual(contents[1]?.parts[1], { functionCall: { name: 'lookup', args: { year: 2026 } } });
  const results = contents[2]?.parts ?? [];
  assert.deepEqual(
    results.filter((part) => part.functionResponse).map((part) => (part.functionResponse as { name: string }).name),
    ['lookup', 'render'],
  );
  assert.ok(results.some((part) => (part.inlineData as { data?: string } | undefined)?.data === base64));

  assert.equal(response.content, 'Here it is.');
  assert.equal(response.assets?.length, 1);
  assert.equal(response.assets?.[0]?.mimeType, 'image/png');
  const location = response.assets?.[0]?.location;
  assert.equal(location?.kind, 'bytes');
  assert.deepEqual([...(location?.kind === 'bytes' ? location.data : [])], [...png]);
});

test('a tool that returns toolOutput reaches the model as parts, not as JSON', async () => {
  const sent: CompletionRequest[] = [];
  const client = {
    async complete(next: CompletionRequest): Promise<NexusResponse> {
      sent.push(structuredClone({ ...next, tools: undefined }));
      const first = sent.length === 1;
      return {
        content: first ? '' : 'Saved it.',
        role: 'assistant',
        ...(first
          ? { toolCalls: [{ id: 'c1', type: 'function' as const, function: { name: 'render', arguments: '{}' } }] }
          : {}),
        finishReason: first ? 'tool_calls' : 'stop',
        meta: {
          requestId: 'r',
          providerUsed: 'mock',
          modelUsed: 'mock',
          latencyMs: 0,
          tokensInput: 0,
          tokensOutput: 0,
          tokensSaved: 0,
          cacheHit: false,
          guardrailsApplied: [],
        },
      };
    },
  };
  const render = tool({
    name: 'render',
    description: 'Renders a chart',
    parameters: { type: 'object', properties: {} },
    execute: () => toolOutput('Stored the chart.', { type: 'asset', asset: stored }),
  });

  const result = await new AgentLoop(client).run({ goal: 'Chart it', model: 'gpt-4o', tools: [render] });
  assert.equal(result.content, 'Saved it.');
  const toolMessage = sent[1]?.messages.find((message) => message.role === 'tool');
  assert.deepEqual(toolMessage?.content, [
    { type: 'text', text: 'Stored the chart.' },
    { type: 'asset', asset: stored },
  ]);
});
