/**
 * Log probabilities from a stream: each text chunk carries its tokens' log probabilities, from OpenAI's
 * Chat Completions and Responses API, Gemini, and Ollama, and the chunks' together are what `complete()`
 * reports. Text the output guard changes keeps none, streamed or not, since they would spell out what
 * it removed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectStreamOutput } from '../src/core/secure-stream.js';
import { completionDecisions, DecisionManager } from '../src/decisions/index.js';
import { CohereProvider } from '../src/providers/cohere.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { SecurityPipeline } from '../src/security/index.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, TokenLogprob } from '../src/types/response.js';

const ask: CompletionRequest = {
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Say hi' }],
  logprobs: { top: 2 },
};

/** A token as a provider reports it, with one alternative. */
const wireToken = (token: string, p: number) => ({
  token,
  logprob: Math.log(p),
  top_logprobs: [
    { token, logprob: Math.log(p) },
    { token: '?', logprob: Math.log(1 - p) },
  ],
});
/** The same token, as every provider's is read. */
const read = (token: string, p: number): TokenLogprob => ({
  token,
  logprob: Math.log(p),
  top: [
    { token, logprob: Math.log(p) },
    { token: '?', logprob: Math.log(1 - p) },
  ],
});

async function chunksOf(stream: NexusStream): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const textOf = (chunks: StreamChunk[]) => chunks.filter((chunk) => chunk.type === 'text');

test('OpenAI’s Chat Completions stream each chunk’s log probabilities with its text', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const provider = new OpenAIProvider({ apiKey: 'k' });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          sent.push(params);
          const reported = params.logprobs === true;
          const chunk = (content: string, tokens: Array<[string, number]>, finish?: string) => ({
            choices: [
              {
                delta: { content },
                ...(reported ? { logprobs: { content: tokens.map(([token, p]) => wireToken(token, p)) } } : {}),
                finish_reason: finish ?? null,
              },
            ],
          });
          return (async function* () {
            yield { choices: [{ delta: { role: 'assistant' } }] };
            yield chunk('Hi', [['Hi', 0.9]]);
            yield chunk(' there', [
              [' th', 0.8],
              ['ere', 0.95],
            ]);
            yield chunk('', [], 'stop');
          })();
        },
      },
    },
  };
  const chunks = await chunksOf(provider.stream(ask));
  assert.deepEqual([sent[0]?.logprobs, sent[0]?.top_logprobs, sent[0]?.stream], [true, 2, true]);
  assert.deepEqual(
    textOf(chunks).map((chunk) => chunk.logprobs),
    [[read('Hi', 0.9)], [read(' th', 0.8), read('ere', 0.95)]],
  );
  const plain = await chunksOf(provider.stream({ ...ask, logprobs: undefined }));
  assert.equal(sent[1]?.logprobs, undefined, 'not asked, not sent');
  assert.ok(
    textOf(plain).every((chunk) => chunk.logprobs === undefined),
    'and none read',
  );
});

test('OpenAI’s Responses API streams each text delta’s log probabilities', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const provider = new OpenAIProvider({ apiKey: 'k' });
  (provider as unknown as { client: unknown }).client = {
    responses: {
      async create(params: Record<string, unknown>) {
        sent.push(params);
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: 'Y', logprobs: [wireToken('Y', 0.7)] };
          yield { type: 'response.output_text.delta', delta: 'es', logprobs: [wireToken('es', 0.99)] };
          yield { type: 'response.completed', response: { model: 'gpt-5.5-pro', usage: {} } };
        })();
      },
    },
  };
  const chunks = await chunksOf(provider.stream({ ...ask, model: 'gpt-5.5-pro' }));
  assert.deepEqual(sent[0]?.include, ['message.output_text.logprobs']);
  assert.deepEqual(
    textOf(chunks).map((chunk) => chunk.logprobs),
    [[read('Y', 0.7)], [read('es', 0.99)]],
  );
  const unasked = await chunksOf(provider.stream({ ...ask, model: 'gpt-5.5-pro', logprobs: undefined }));
  assert.ok(
    textOf(unasked).every((chunk) => chunk.logprobs === undefined),
    'a delta’s log probabilities are read only when asked for',
  );
});

test('Gemini streams each chunk’s log probabilities with its first text part, never with a thought', async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  const event = (parts: unknown[], tokens: Array<[string, number]>) =>
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { parts },
          logprobsResult: {
            chosenCandidates: tokens.map(([token, p]) => ({ token, logProbability: Math.log(p) })),
            topCandidates: tokens.map(([token, p]) => ({
              candidates: [
                { token, logProbability: Math.log(p) },
                { token: '?', logProbability: Math.log(1 - p) },
              ],
            })),
          },
        },
      ],
    })}\n\n`;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    const text = [
      event([{ text: 'thinking', thought: true }, { text: 'B' }, { text: '!' }], [['B', 0.6]]),
      event([{ text: 'ye' }], [['ye', 0.9]]),
    ].join('');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  try {
    const chunks = await chunksOf(new GoogleProvider({ apiKey: 'k' }).stream({ ...ask, model: 'gemini-2.5-flash' }));
    assert.equal((body.generationConfig as Record<string, unknown>).responseLogprobs, true);
    assert.equal(chunks[0]?.type, 'reasoning');
    assert.equal(chunks[0]?.logprobs, undefined, 'a thought carries none');
    assert.deepEqual(
      textOf(chunks).map((chunk) => [chunk.content, chunk.logprobs]),
      [
        ['B', [read('B', 0.6)]],
        ['!', undefined],
        ['ye', [read('ye', 0.9)]],
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('Ollama streams each chunk’s log probabilities, and stops a stream where it stops a call', async () => {
  const provider = new OllamaProvider({});
  const sent: Array<Record<string, unknown>> = [];
  (provider as unknown as { client: unknown }).client = {
    async chat(params: Record<string, unknown>) {
      sent.push(params);
      return (async function* () {
        yield { message: { content: 'No' }, logprobs: [wireToken('No', 0.85)] };
        yield { message: { content: '' }, done: true, prompt_eval_count: 3, eval_count: 1 };
      })();
    },
  };
  const chunks = await chunksOf(provider.stream({ ...ask, model: 'llama3', stop: ['\n'] }));
  assert.deepEqual([sent[0]?.logprobs, sent[0]?.top_logprobs], [true, 2]);
  const options = sent[0]?.options as { stop?: string[] } | undefined;
  assert.deepEqual(options?.stop, ['\n'], 'the stop sequence, as a call has it');
  assert.deepEqual(
    textOf(chunks).map((chunk) => chunk.logprobs),
    [[read('No', 0.85)]],
  );
  await chunksOf(provider.stream({ ...ask, model: 'llama3', logprobs: undefined }));
  assert.equal(sent[1]?.logprobs, undefined);
});

/** A stream of these chunks, as a provider yields them. */
function streamOf(chunks: StreamChunk[]): NexusStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
    abort() {},
  };
}

test('text the output guard changes keeps no log probabilities, streamed or not: they would spell out what it removed', async () => {
  const security = new SecurityPipeline({ level: 'standard', output: { piiRedaction: true } });
  const tokens = [read('ana', 0.9), read('@example.com', 0.9)];
  const response = (content: string): NexusResponse =>
    ({
      content,
      role: 'assistant',
      finishReason: 'stop',
      logprobs: tokens,
      meta: { guardrailsApplied: [] },
    }) as unknown as NexusResponse;

  const redacted = security.protectOutput(response('Write to ana@example.com'));
  assert.equal(redacted.value.content, 'Write to [REDACTED]');
  assert.equal(redacted.value.logprobs, undefined, 'a redacted answer’s log probabilities are dropped');
  const clean = security.protectOutput(response('Write to her'));
  assert.deepEqual(clean.value.logprobs, tokens, 'an answer left as it was keeps them');

  const streamed = await chunksOf(
    protectStreamOutput(
      streamOf([
        { type: 'text', content: 'Write to ', logprobs: [read('Write', 0.9)] },
        { type: 'text', content: 'ana@example.com', logprobs: tokens },
        { type: 'done', meta: {} },
      ]),
      security,
    ),
  );
  assert.equal(
    textOf(streamed)
      .map((chunk) => chunk.content)
      .join(''),
    'Write to [REDACTED]',
  );
  assert.ok(
    textOf(streamed).every((chunk) => chunk.logprobs === undefined),
    'and no streamed chunk of a changed answer keeps them',
  );
  const untouched = await chunksOf(
    protectStreamOutput(
      streamOf([{ type: 'text', content: 'Hello', logprobs: [read('Hello', 0.9)] }, { type: 'done' }]),
      security,
    ),
  );
  assert.deepEqual(textOf(untouched)[0]?.logprobs, [read('Hello', 0.9)], 'a stream left as it was keeps them');
});

test('Cohere reports log probabilities a piece of text at a time, streamed or not, with no alternatives', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new CohereProvider({
    apiKey: 'k',
    fetch: (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return Response.json({
        model: 'command-a-03-2025',
        message: { content: [{ text: 'Yes, indeed' }] },
        usage: { tokens: { input_tokens: 4, output_tokens: 3 } },
        ...(body.logprobs
          ? {
              logprobs: [
                { token_ids: [1], text: 'Yes', logprobs: [Math.log(0.8)] },
                { token_ids: [2, 3], text: ', indeed', logprobs: [Math.log(0.5), Math.log(0.9)] },
              ],
            }
          : {}),
      });
    }) as typeof fetch,
  });
  const expected: TokenLogprob[] = [
    { token: 'Yes', logprob: Math.log(0.8) },
    { token: ', indeed', logprob: Math.log(0.5) + Math.log(0.9) },
  ];
  const response = await provider.complete({ ...ask, model: 'cohere/command-a-03-2025' });
  assert.equal(bodies[0]?.logprobs, true);
  assert.deepEqual(response.logprobs, expected, 'a piece of several tokens, their log probabilities summed');
  const streamed = await chunksOf(provider.stream({ ...ask, model: 'cohere/command-a-03-2025' }));
  assert.deepEqual(textOf(streamed)[0]?.logprobs, expected, 'and its one streamed chunk carries them');
  const unasked = await provider.complete({ ...ask, model: 'cohere/command-a-03-2025', logprobs: undefined });
  assert.deepEqual([bodies[2]?.logprobs, unasked.logprobs], [undefined, undefined]);

  // A decision asked of a model that reports no alternatives is sampled, not read as certain.
  let calls = 0;
  const decisions = completionDecisions(
    {
      complete: async (request: CompletionRequest) => {
        calls += 1;
        return {
          content: 'Y',
          role: 'assistant',
          finishReason: 'stop',
          ...(request.logprobs ? { logprobs: [{ token: 'Y', logprob: Math.log(0.6) }] } : {}),
          meta: {},
        } as unknown as NexusResponse;
      },
    },
    { model: 'chosen-only', samples: 4 },
  );
  const decided = await new DecisionManager({ providers: { chosen: decisions } }).decide({
    state: 'The invoice was paid.',
    questions: { paid: { type: 'yes-no' } },
  });
  assert.equal(decisions.sampledModels.has('chosen-only'), true, 'sampled from then on');
  assert.equal(calls, 5, 'one call that could not be read, then four samples');
  assert.equal(decided.answers.paid.probability, 1, 'four samples, all yes');
});
