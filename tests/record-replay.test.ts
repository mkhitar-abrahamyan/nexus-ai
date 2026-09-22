import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenAIImageProvider } from '../src/images/openai.js';
import {
  FixtureMissingError,
  fixtureFetch,
  installFetch,
  type RecordedExchange,
  readFixtures,
  recordingFetch,
  replayFetch,
} from '../src/testing/record.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-fixtures-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Stands in for a provider: JSON, a stream of events, and an image. Counts the calls it gets. */
function fakeProvider() {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/chat')) {
      const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
      return new Response(JSON.stringify({ reply: `saw ${body.messages.length} messages` }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc', 'content-encoding': 'gzip' },
      });
    }
    if (url.includes('/stream')) {
      return new Response('data: {"delta":"he"}\n\ndata: {"delta":"llo"}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  };
  return { fetch, calls };
}

test('recorded exchanges replay byte for byte with no network, and credentials never reach the files', async () => {
  await withDirectory(async (directory) => {
    const provider = fakeProvider();
    const record = recordingFetch({ directory, fetch: provider.fetch });

    const chat = await record('https://api.example.test/v1/chat?key=sk-secret&b=2&a=1', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-live-123', 'x-api-key': 'sk-live-123', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.deepEqual(await chat.json(), { reply: 'saw 1 messages' }, 'the caller still reads the live response');
    await record('https://api.example.test/v1/stream');
    await record('https://images.example.test/v1/render.png');
    await record.flush();

    const files = await readdir(directory);
    assert.equal(files.length, 3);
    const written = (await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')))).join('\n');
    assert.doesNotMatch(written, /sk-live-123|sk-secret|session=abc/, 'credentials are redacted before writing');
    assert.match(written, /\[REDACTED\]/);

    const fixtures = await readFixtures(directory);
    const chatFixture = fixtures.find((exchange) => exchange.request.url.includes('/chat')) as RecordedExchange;
    assert.equal(chatFixture.request.url, 'https://api.example.test/v1/chat?a=1&b=2', 'query sorted, key removed');
    assert.equal(chatFixture.response.headers['content-encoding'], undefined, 'fetch already decoded the body');

    const replay = replayFetch({ directory });
    const before = provider.calls.length;
    const again = await replay('https://api.example.test/v1/chat?a=1&b=2&key=another-key', {
      method: 'POST',
      // Key order in the body does not change the match.
      body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], model: 'm' }),
    });
    assert.deepEqual(await again.json(), { reply: 'saw 1 messages' });
    assert.equal(
      await (await replay('https://api.example.test/v1/stream')).text(),
      'data: {"delta":"he"}\n\ndata: {"delta":"llo"}\n\ndata: [DONE]\n\n',
    );
    assert.deepEqual(
      new Uint8Array(await (await replay('https://images.example.test/v1/render.png')).arrayBuffer()),
      PNG,
      'binary bodies survive as base64',
    );
    assert.equal(provider.calls.length, before, 'replay made no calls');

    await assert.rejects(
      replay('https://api.example.test/v1/chat', { method: 'POST', body: '{"messages":[]}' }),
      (error: unknown) => error instanceof FixtureMissingError && /No recorded response for POST/.test(error.message),
    );
    const live = replayFetch({ directory, onMissing: 'live', fetch: provider.fetch });
    await live('https://api.example.test/v1/chat', { method: 'POST', body: '{"messages":[]}' });
    assert.equal(provider.calls.length, before + 1, 'live fallback only when asked for');
  });
});

test('repeated requests replay in recorded order and then repeat the last, as a polling loop needs', async () => {
  await withDirectory(async (directory) => {
    let state = 0;
    const polling = recordingFetch({
      directory,
      fetch: async () => new Response(JSON.stringify({ status: ++state < 3 ? 'running' : 'done' })),
    });
    for (let index = 0; index < 3; index += 1) await polling('https://jobs.example.test/1');
    await polling.flush();

    const replay = replayFetch({ directory });
    const seen: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      seen.push(((await (await replay('https://jobs.example.test/1')).json()) as { status: string }).status);
    }
    assert.deepEqual(seen, ['running', 'running', 'done', 'done']);
  });
});

test('volatile body fields can be left out of matching, and a redact hook sees every exchange', async () => {
  await withDirectory(async (directory) => {
    const record = recordingFetch({
      directory,
      fetch: async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      ignoreBodyFields: ['requestId'],
      redact: (exchange) => ({
        ...exchange,
        request: { ...exchange.request, body: exchange.request.body?.replace(/[\w.]+@[\w.]+/g, '[EMAIL]') },
      }),
    });
    await record('https://api.example.test/v1/answer', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'r-1', question: 'mail alice@example.com' }),
    });
    await record.flush();
    assert.doesNotMatch(JSON.stringify(await readFixtures(directory)), /alice@example\.com/);

    const replay = replayFetch({ directory, ignoreBodyFields: ['requestId'] });
    const response = await replay('https://api.example.test/v1/answer', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'r-2', question: 'mail alice@example.com' }),
    });
    assert.deepEqual(await response.json(), { ok: true });

    const custom = replayFetch({ directory, match: () => 'nothing-matches-this' });
    await assert.rejects(custom('https://api.example.test/v1/answer'), FixtureMissingError);
  });
});

test('a real provider adapter runs against recordings with no credentials and no network', async () => {
  await withDirectory(async (directory) => {
    const server = async (input: unknown, init?: RequestInit): Promise<Response> => {
      assert.match(String(input), /\/images\/generations$/);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-real-key');
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }), {
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
      });
    };
    const context = { operationId: 'op', requestId: 'req', signal: new AbortController().signal };
    const request = { prompt: 'a blue square', model: 'auto', count: 1, outputFormat: 'png' as const };

    const recorder = recordingFetch({ directory, fetch: server as typeof globalThis.fetch });
    const recording = new OpenAIImageProvider({ apiKey: 'sk-real-key', fetch: recorder, defaultModel: 'gpt-image-1' });
    await recording.generate(request, context);
    await recorder.flush();

    // A contributor's checkout: a placeholder key and no server at all.
    const replaying = new OpenAIImageProvider({
      apiKey: 'placeholder',
      fetch: replayFetch({ directory }),
      defaultModel: 'gpt-image-1',
    });
    const result = await replaying.generate(request, context);
    assert.equal(result.assets.length, 1);
    const location = result.assets[0]?.location;
    assert.deepEqual(location?.kind === 'bytes' ? new Uint8Array(location.data) : undefined, PNG);
  });
});

test('installFetch covers code that calls the global fetch, and fixtureFetch picks a mode', async () => {
  await withDirectory(async (directory) => {
    const original = globalThis.fetch;
    const record = recordingFetch({ directory, fetch: async () => new Response('recorded') });
    const restore = installFetch(record);
    try {
      assert.equal(await (await fetch('https://global.example.test/')).text(), 'recorded');
    } finally {
      restore();
    }
    assert.equal(globalThis.fetch, original, 'restored');
    await record.flush();

    const replay = fixtureFetch({ directory, mode: 'replay' });
    assert.equal(await (await replay('https://global.example.test/')).text(), 'recorded');
    assert.throws(() => fixtureFetch({ directory, mode: 'sideways' as never }), /Unknown fixture mode/);

    const previous = process.env.NEXUS_FIXTURES;
    process.env.NEXUS_FIXTURES = 'record';
    try {
      assert.equal(typeof (fixtureFetch({ directory }) as { flush?: unknown }).flush, 'function');
    } finally {
      if (previous === undefined) delete process.env.NEXUS_FIXTURES;
      else process.env.NEXUS_FIXTURES = previous;
    }
  });
});

test('a multipart upload matches its recording although every run picks a new boundary', async () => {
  await withDirectory(async (directory) => {
    const upload = () => {
      const form = new FormData();
      form.set('prompt', 'make the sky orange');
      form.set('image', new Blob([PNG], { type: 'image/png' }), 'input.png');
      return form;
    };
    const record = recordingFetch({ directory, fetch: async () => new Response('{"edited":true}') });
    await record('https://images.example.test/v1/edits', { method: 'POST', body: upload() });
    await record.flush();

    const replay = replayFetch({ directory });
    const response = await replay('https://images.example.test/v1/edits', { method: 'POST', body: upload() });
    assert.deepEqual(await response.json(), { edited: true });

    const changed = new FormData();
    changed.set('prompt', 'make the sky green');
    await assert.rejects(
      replay('https://images.example.test/v1/edits', { method: 'POST', body: changed }),
      FixtureMissingError,
      'a different upload is still a different request',
    );
  });
});
