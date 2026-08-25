import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CohereProvider,
  GoogleProvider,
  OllamaProvider,
  type CompletionRequest,
  type StreamChunk,
} from '../src/index.js';

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'gemini-3.5-pro',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

async function* asyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * Replaces the global fetch for one call and restores it afterwards.
 *
 * The Google and Cohere adapters call `fetch` directly rather than through an injected client, so a
 * captured request body is the only way to assert what actually goes on the wire.
 */
async function withFetch<T>(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; body: Record<string, unknown> }> }> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return handler(url, init || {});
  }) as typeof globalThis.fetch;

  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sseResponse(events: unknown[]): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// ── Google ─────────────────────────────────────────────────────────

test('Google maps reasoning, sampling, and tool-choice controls onto its request body', async () => {
  const { result, calls } = await withFetch(
    () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          cachedContentTokenCount: 600,
          thoughtsTokenCount: 120,
        },
      }),
    () =>
      new GoogleProvider({ apiKey: 'test' }).complete(
        request({
          topK: 40,
          seed: 11,
          frequencyPenalty: 0.2,
          presencePenalty: 0.1,
          maxTokens: 512,
          reasoning: { effort: 'high', summary: 'auto' },
          tools: [{ name: 'lookup', description: 'x', parameters: {} }],
          toolChoice: { name: 'lookup' },
        }),
      ),
  );

  const body = calls[0].body;
  const generationConfig = body.generationConfig as Record<string, unknown>;
  assert.equal(generationConfig.topK, 40);
  assert.equal(generationConfig.seed, 11);
  assert.equal(generationConfig.frequencyPenalty, 0.2);
  assert.equal(generationConfig.presencePenalty, 0.1);
  assert.deepEqual(generationConfig.thinkingConfig, { thinkingBudget: 16384, includeThoughts: true });
  assert.deepEqual(body.toolConfig, {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] },
  });

  // promptTokenCount includes the cached share, so only the remainder is billed as fresh input.
  assert.equal(result.meta.usage?.inputTokens, 400);
  assert.equal(result.meta.usage?.cachedReadTokens, 600);
  assert.equal(result.meta.usage?.reasoningTokens, 120);
  assert.equal(result.meta.tokensInput, 1000);
  assert.ok((result.meta.cost?.amount ?? 0) > 0);
});

test('Google omits thinking and tool config when the request asks for neither', async () => {
  const { calls } = await withFetch(
    () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    () => new GoogleProvider({ apiKey: 'test' }).complete(request()),
  );

  const generationConfig = calls[0].body.generationConfig as Record<string, unknown>;
  assert.equal('thinkingConfig' in generationConfig, false, "the model's own default is left in place");
  assert.equal('toolConfig' in calls[0].body, false);
});

test('Google maps required and forbidden tool choices onto function-calling modes', async () => {
  for (const [choice, mode] of [
    ['required', 'ANY'],
    ['none', 'NONE'],
    ['auto', 'AUTO'],
  ] as const) {
    const { calls } = await withFetch(
      () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      () =>
        new GoogleProvider({ apiKey: 'test' }).complete(
          request({ tools: [{ name: 'lookup', description: 'x', parameters: {} }], toolChoice: choice }),
        ),
    );

    const toolConfig = calls[0].body.toolConfig as { functionCallingConfig: { mode: string } };
    assert.equal(toolConfig.functionCallingConfig.mode, mode);
  }
});

test('Google keeps reasoning summaries out of visible content', async () => {
  const { result } = await withFetch(
    () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: 'internal deliberation', thought: true }, { text: 'the visible answer' }],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    () => new GoogleProvider({ apiKey: 'test' }).complete(request({ reasoning: { summary: 'detailed' } })),
  );

  assert.equal(result.content, 'the visible answer');
});

test('Google streams thought parts as reasoning chunks and reports final usage', async () => {
  const provider = new GoogleProvider({ apiKey: 'test' });
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      { candidates: [{ content: { parts: [{ text: 'weighing options', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'final' }] } }] },
      {
        candidates: [{ content: { parts: [] } }],
        usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12, cachedContentTokenCount: 40 },
      },
    ])) as typeof globalThis.fetch;

  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(request())) chunks.push(chunk);

    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ['reasoning', 'text', 'done'],
    );
    assert.equal(chunks[0].content, 'weighing options');
    assert.equal(chunks[1].content, 'final');
    assert.equal(chunks[2].meta?.usage?.inputTokens, 50);
    assert.equal(chunks[2].meta?.usage?.cachedReadTokens, 40);
    assert.notEqual(chunks[2].meta?.estimatedCost, '$0.00', 'streamed responses report real cost');
  } finally {
    globalThis.fetch = original;
  }
});

test('Google surfaces an HTTP failure as a normalized provider error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 429 })) as typeof globalThis.fetch;

  try {
    await assert.rejects(() => new GoogleProvider({ apiKey: 'test' }).complete(request()), /google/i);
  } finally {
    globalThis.fetch = original;
  }
});

// ── Ollama ─────────────────────────────────────────────────────────

function ollamaWithClient(chat: (params: Record<string, unknown>) => unknown): OllamaProvider {
  const provider = new OllamaProvider({});
  (provider as unknown as { client: unknown }).client = { chat };
  return provider;
}

test('Ollama forwards sampling controls and prices the response from the registry', async () => {
  let captured: Record<string, unknown> = {};
  const provider = ollamaWithClient(async (params) => {
    captured = params;
    return { message: { content: 'local answer' }, prompt_eval_count: 30, eval_count: 12, done: true };
  });

  const response = await provider.complete(
    request({
      model: 'ollama/llama3',
      topK: 25,
      seed: 5,
      frequencyPenalty: 0.4,
      presencePenalty: 0.3,
      temperature: 0.2,
      maxTokens: 256,
      stop: 'STOP',
    }),
  );

  const options = captured.options as Record<string, unknown>;
  assert.equal(options.top_k, 25);
  assert.equal(options.seed, 5);
  assert.equal(options.frequency_penalty, 0.4);
  assert.equal(options.presence_penalty, 0.3);
  assert.equal(options.num_predict, 256);
  assert.deepEqual(options.stop, ['STOP']);

  assert.equal(response.content, 'local answer');
  assert.equal(response.meta.usage?.inputTokens, 30);
  assert.equal(response.meta.usage?.outputTokens, 12);
  assert.equal(response.meta.usage?.totalTokens, 42);
  // A local model has no bundled price, so the estimate is honestly zero rather than invented.
  assert.equal(response.meta.cost?.amount, 0);
});

test('Ollama streams text and reports usage on the final chunk', async () => {
  const provider = ollamaWithClient(async () =>
    asyncGenerator([
      { message: { content: 'partial ' }, done: false },
      { message: { content: 'answer' }, done: false },
      { message: { content: '' }, done: true, prompt_eval_count: 7, eval_count: 3 },
    ]),
  );

  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream(request({ model: 'ollama/llama3', topK: 10 }))) chunks.push(chunk);

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['text', 'text', 'done'],
  );
  assert.equal(chunks[2].meta?.usage?.inputTokens, 7);
  assert.equal(chunks[2].meta?.usage?.outputTokens, 3);
});

// ── Cohere ─────────────────────────────────────────────────────────

test('Cohere forwards sampling controls and normalizes block content', async () => {
  const { result, calls } = await withFetch(
    () =>
      jsonResponse({
        model: 'command-a-03-2025',
        message: { content: [{ text: 'first ' }, { text: 'second' }] },
        usage: { tokens: { input_tokens: 21, output_tokens: 9 } },
      }),
    () =>
      new CohereProvider({ apiKey: 'test' }).complete(
        request({
          model: 'cohere/command-a-03-2025',
          topP: 0.9,
          topK: 12,
          seed: 3,
          frequencyPenalty: 0.6,
          presencePenalty: 0.5,
          maxTokens: 128,
        }),
      ),
  );

  const body = calls[0].body;
  assert.equal(body.model, 'command-a-03-2025', 'the cohere/ prefix is stripped before the wire call');
  assert.equal(body.k, 12);
  assert.equal(body.p, 0.9);
  assert.equal(body.seed, 3);
  assert.equal(body.frequency_penalty, 0.6);
  assert.equal(body.presence_penalty, 0.5);

  assert.equal(result.content, 'first second');
  assert.equal(result.meta.tokensInput, 21);
  assert.equal(result.meta.tokensOutput, 9);
});

test('Cohere streams the buffered answer and reports an error chunk on failure', async () => {
  const okProvider = new CohereProvider({ apiKey: 'test' });
  const original = globalThis.fetch;

  globalThis.fetch = (async () =>
    jsonResponse({
      message: { content: 'buffered' },
      usage: { input_tokens: 2, output_tokens: 1 },
    })) as typeof globalThis.fetch;
  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of okProvider.stream(request({ model: 'cohere/command-r' }))) chunks.push(chunk);
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ['text', 'done'],
    );
    assert.equal(chunks[0].content, 'buffered');
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = (async () => new Response('denied', { status: 401 })) as typeof globalThis.fetch;
  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of new CohereProvider({ apiKey: 'bad' }).stream(request({ model: 'cohere/command-r' }))) {
      chunks.push(chunk);
    }
    assert.equal(chunks.at(-1)?.type, 'error');
  } finally {
    globalThis.fetch = original;
  }
});
