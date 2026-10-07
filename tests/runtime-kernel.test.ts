/**
 * What makes the kernel portable, tested where coverage is measured: the Web Crypto ids, the
 * SHA-256 that matches Node's digest byte for byte, base64 and UTF-8 lengths without `Buffer`,
 * runtime detection, and providers that take any `fetch`.
 *
 * The same kernel also runs on Deno, Bun, and an edge runtime: `tests/portable/`.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { CohereProvider } from '../src/providers/cohere.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { runtimeInfo } from '../src/runtime/detect.js';
import { decodeBase64, encodeBase64 } from '../src/utils/base64.js';
import { randomHex, utf8Length } from '../src/utils/ids.js';
import { Sha256, sha256Hex } from '../src/utils/sha256.js';

const nodeDigest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

test('SHA-256 in plain JavaScript gives Node’s digest, whole or in pieces, for bytes and text', () => {
  for (let length = 0; length < 300; length += 1) {
    const bytes = randomBytes(length < 200 ? length : length * 37);
    assert.equal(new Sha256().update(bytes).digest(), nodeDigest(bytes), `${bytes.length} bytes`);
    const pieces = new Sha256();
    for (let at = 0; at < bytes.length; at += 1 + (at % 70)) pieces.update(bytes.subarray(at, at + 1 + (at % 70)));
    assert.equal(pieces.digest(), nodeDigest(bytes), `${bytes.length} bytes in pieces`);
  }
  for (const text of ['', 'abc', 'héllo wörld', '日本語', '😀', 'lone \ud800 surrogate', 'x'.repeat(10_000)]) {
    assert.equal(new Sha256().update(text).digest(), nodeDigest(text));
    assert.equal(sha256Hex(text), nodeDigest(text));
  }
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('random ids come from Web Crypto, and UTF-8 lengths match Buffer’s count', () => {
  const ids = new Set(Array.from({ length: 100 }, () => randomHex(6)));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{12}$/);
  for (const text of ['', 'ascii', 'ü', '€', '😀', 'a\ud800b', '\udc00', 'mixed 日本 😀 text']) {
    assert.equal(utf8Length(text), Buffer.byteLength(text), JSON.stringify(text));
  }
});

test('base64 round-trips with Buffer and without it', () => {
  const bytes = randomBytes(100_000);
  const text = encodeBase64(bytes);
  assert.equal(text, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(decodeBase64(text), new Uint8Array(bytes));
  const saved = globalThis.Buffer;
  try {
    // @ts-expect-error: a runtime without Node's Buffer.
    delete globalThis.Buffer;
    assert.equal(encodeBase64(bytes), text);
    assert.deepEqual(decodeBase64(text), new Uint8Array(bytes));
  } finally {
    globalThis.Buffer = saved;
  }
  const floats = new Float32Array(
    decodeBase64(encodeBase64(new Uint8Array(new Float32Array([0.5, -2]).buffer))).buffer,
  );
  assert.deepEqual([...floats], [0.5, -2], 'a decoded buffer is aligned for a typed view');
});

test('runtimeInfo() names each runtime by what it exposes', () => {
  assert.deepEqual(runtimeInfo(), { name: 'node', version: process.versions.node });
  const host = globalThis as Record<string, unknown>;
  const cases: Array<[Record<string, unknown>, unknown]> = [
    [{ Deno: { version: { deno: '2.9.6' } } }, { name: 'deno', version: '2.9.6' }],
    [{ Bun: { version: '1.3.9' } }, { name: 'bun', version: '1.3.9' }],
    [{ EdgeRuntime: 'edge-runtime', process: undefined }, { name: 'edge-light' }],
    [{ process: undefined, navigator: { userAgent: 'Cloudflare-Workers' } }, { name: 'workerd' }],
    [{ process: undefined, navigator: { userAgent: 'Mozilla/5.0' }, document: {} }, { name: 'browser' }],
    [{ process: undefined, navigator: { userAgent: 'Mozilla/5.0' } }, { name: 'unknown' }],
  ];
  for (const [globals, expected] of cases) {
    const saved = Object.fromEntries(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(host, key)]),
    );
    try {
      for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(host, key, { value, configurable: true, writable: true });
      }
      assert.deepEqual(runtimeInfo(), expected);
    } finally {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(host, key, descriptor);
        else delete host[key];
      }
    }
  }
});

test('providers send every request through the fetch they are given', async () => {
  const calls: string[] = [];
  const reply = (body: unknown) => async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Response.json(body);
  };
  const messages = [{ role: 'user' as const, content: 'Hi' }];

  const openai = new OpenAIProvider({
    apiKey: 'test',
    baseUrl: 'https://llm.example.test/v1',
    fetch: reply({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-5.4-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'from openai' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  });
  assert.equal((await openai.complete({ model: 'gpt-5.4-mini', messages })).content, 'from openai');

  const anthropic = new AnthropicProvider({
    apiKey: 'test',
    baseUrl: 'https://claude.example.test',
    fetch: reply({
      id: 'm1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'from anthropic' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
  });
  assert.equal(
    (await anthropic.complete({ model: 'claude-sonnet-5-5', messages, maxTokens: 100 })).content,
    'from anthropic',
  );

  const cohere = new CohereProvider({
    apiKey: 'test',
    baseUrl: 'https://cohere.example.test',
    fetch: reply({
      id: 'r1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from cohere' }] },
      finish_reason: 'COMPLETE',
      usage: { tokens: { input_tokens: 1, output_tokens: 2 } },
    }),
  });
  assert.equal((await cohere.complete({ model: 'command-a', messages })).content, 'from cohere');

  assert.deepEqual(
    calls.map((url) => new URL(url).host),
    ['llm.example.test', 'claude.example.test', 'cohere.example.test'],
  );
});
