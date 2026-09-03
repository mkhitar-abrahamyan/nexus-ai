import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicBatchProvider } from '../src/batch/anthropic.js';
import {
  BatchCapabilityError,
  BatchProviderNotFoundError,
  BatchProviderResponseError,
  BatchValidationError,
} from '../src/batch/errors.js';
import { BatchManager } from '../src/batch/manager.js';
import { MockBatchProvider } from '../src/batch/mock.js';
import { OpenAIBatchProvider } from '../src/batch/openai.js';
import { isTerminalBatchStatus } from '../src/types/batch.js';
import type { BatchInputItem, BatchProviderCallContext } from '../src/types/batch.js';

function items(...ids: string[]): BatchInputItem[] {
  return ids.map((customId) => ({
    customId,
    request: { model: 'gpt-5.4-mini', messages: [{ role: 'user' as const, content: `question ${customId}` }] },
  }));
}

function context(): BatchProviderCallContext {
  return { requestId: 'test', signal: new AbortController().signal, attempt: 1 };
}

function manager(provider = new MockBatchProvider()): { manager: BatchManager; provider: MockBatchProvider } {
  return {
    manager: new BatchManager({ providers: { mock: provider }, defaultProvider: 'mock', pollIntervalMs: 1 }),
    provider,
  };
}

function jsonFetch(
  handlers: Record<string, unknown>,
  capture?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    capture?.(url, init);
    const key = Object.keys(handlers).find((path) => url.includes(path));
    if (!key) return new Response('not found', { status: 404 });
    const value = handlers[key];
    if (typeof value === 'string') return new Response(value, { status: 200 });
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

// ── Validation ─────────────────────────────────────────────────────

test('an empty batch is refused', async () => {
  const { manager: batch } = manager();
  await assert.rejects(() => batch.submit({ items: [] }), BatchValidationError);
});

test('a duplicate customId is refused before submission', async () => {
  // Duplicates make results ambiguous and no provider detects it.
  const { manager: batch, provider } = manager();
  await assert.rejects(
    () => batch.submit({ items: [...items('a'), ...items('a')] }),
    (error: unknown) => error instanceof BatchValidationError && /Duplicate/.test(error.message),
  );
  assert.equal(provider.submitted.size, 0);
});

test('an item without a customId or messages is refused', async () => {
  const { manager: batch } = manager();
  await assert.rejects(
    () =>
      batch.submit({ items: [{ customId: '', request: { model: 'm', messages: [{ role: 'user', content: 'x' }] } }] }),
    BatchValidationError,
  );
  await assert.rejects(
    () => batch.submit({ items: [{ customId: 'a', request: { model: 'm', messages: [] } }] }),
    BatchValidationError,
  );
});

test('a batch larger than the provider limit is refused', async () => {
  const { manager: batch } = manager(new MockBatchProvider({ capabilities: { maxItems: 2 } }));
  await assert.rejects(() => batch.submit({ items: items('a', 'b', 'c') }), BatchCapabilityError);
});

test('an unsupported completion window is refused', async () => {
  const { manager: batch } = manager();
  await assert.rejects(() => batch.submit({ items: items('a'), completionWindow: '1h' }), BatchCapabilityError);
});

test('an unregistered provider is reported clearly', async () => {
  const { manager: batch } = manager();
  await assert.rejects(() => batch.submit({ items: items('a'), provider: 'nope' }), BatchProviderNotFoundError);
  await assert.rejects(() => new BatchManager().submit({ items: items('a') }), BatchProviderNotFoundError);
});

// ── Lifecycle ──────────────────────────────────────────────────────

test('a batch submits, polls, and collects results', async () => {
  const { manager: batch, provider } = manager(
    new MockBatchProvider({ statuses: ['validating', 'in_progress', 'completed'] }),
  );

  const handle = await batch.submit({ items: items('a', 'b') });
  const result = await handle.result();

  assert.equal(result.status, 'completed');
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => item.customId),
    ['a', 'b'],
  );
  assert.equal(result.items[0]?.response?.content, 'echo:a');
  assert.equal(provider.pollCount(result.ref.id), 3);
});

test('the operation handle reports progress while the batch runs', async () => {
  const { manager: batch } = manager(new MockBatchProvider({ statuses: ['in_progress', 'completed'] }));

  const handle = await batch.submit({ items: items('a') });
  const events = [];
  for await (const event of handle.events()) events.push(event);

  assert.equal(events[0]?.type, 'queued');
  assert.ok(events.some((event) => event.type === 'progress'));
  assert.equal(events.at(-1)?.type, 'succeeded');
});

test('a mixed batch reports per-item errors without failing the whole job', async () => {
  const { manager: batch } = manager(new MockBatchProvider({ failItems: ['b'] }));

  const result = await (await batch.submit({ items: items('a', 'b', 'c') })).result();

  assert.equal(result.status, 'completed');
  assert.equal(result.counts.completed, 2);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.items.find((item) => item.customId === 'b')?.error?.code, 'mock_error');
  assert.ok(result.items.find((item) => item.customId === 'a')?.response);
});

test('usage is summed and priced at the batch discount', async () => {
  const { manager: batch } = manager(new MockBatchProvider({ tokensPerItem: { input: 1000, output: 1000 } }));

  const result = await (await batch.submit({ items: items('a', 'b'), model: 'gpt-5.4-mini' })).result();

  assert.equal(result.usage.inputTokens, 2000);
  assert.equal(result.usage.outputTokens, 2000);
  assert.equal(result.cost.basis, 'estimated');
  assert.ok(result.cost.amount > 0);

  // The same work at full price must cost exactly twice the 0.5 discounted rate.
  const fullPrice = manager(
    new MockBatchProvider({ tokensPerItem: { input: 1000, output: 1000 }, capabilities: { discount: 1 } }),
  );
  const undiscounted = await (
    await fullPrice.manager.submit({ items: items('a', 'b'), model: 'gpt-5.4-mini' })
  ).result();
  assert.ok(Math.abs(undiscounted.cost.amount - result.cost.amount * 2) < 1e-9);
});

test('a failed batch returns no items rather than inventing them', async () => {
  const { manager: batch } = manager(new MockBatchProvider({ statuses: ['failed'] }));
  const result = await (await batch.submit({ items: items('a') })).result();

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.items, []);
});

test('polling backs off rather than hammering a slow batch', async () => {
  const provider = new MockBatchProvider({
    statuses: ['in_progress', 'in_progress', 'in_progress', 'completed'],
  });
  const batch = new BatchManager({
    providers: { mock: provider },
    defaultProvider: 'mock',
    pollIntervalMs: 1,
    maxPollIntervalMs: 4,
  });

  const started = Date.now();
  await (await batch.submit({ items: items('a') })).result();
  // 1 + 1.5 + 2.25ms of sleeping is still nearly instant; the point is that it completed and the
  // interval grew rather than staying fixed.
  assert.ok(Date.now() - started < 1_000);
  assert.equal(provider.pollCount('mock-batch-1'), 4);
});

// ── Resume, status, cancel ─────────────────────────────────────────

test('a batch can be resumed from its ref alone', async () => {
  // The point of the ref: a restarted worker collects a batch it never submitted.
  const provider = new MockBatchProvider();
  const submitter = new BatchManager({ providers: { mock: provider }, defaultProvider: 'mock', pollIntervalMs: 1 });
  const handle = await submitter.submit({ items: items('a') });
  const first = await handle.result();

  const other = new BatchManager({ providers: { mock: provider }, pollIntervalMs: 1 });
  const resumed = await other.resume(first.ref);

  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.items[0]?.customId, 'a');
});

test('resuming an unknown provider is reported', async () => {
  const { manager: batch } = manager();
  await assert.rejects(() => batch.resume({ id: 'x', provider: 'ghost' }), BatchProviderNotFoundError);
});

test('status reports provider state without waiting', async () => {
  const { manager: batch } = manager(new MockBatchProvider({ statuses: ['in_progress'] }));
  const handle = await batch.submit({ items: items('a'), pollIntervalMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = await batch.status({ id: 'mock-batch-1', provider: 'mock' });
  assert.equal(state.status, 'in_progress');
  handle.cancel();
});

test('cancel is refused when the provider cannot do it', async () => {
  const { manager: batch } = manager(new MockBatchProvider({ capabilities: { supportsCancel: false } }));
  const provider = new MockBatchProvider({ capabilities: { supportsCancel: false } });
  const noCancel = {
    info: provider.info,
    submit: provider.submit.bind(provider),
    poll: provider.poll.bind(provider),
    results: provider.results.bind(provider),
  };
  const withoutCancel = new BatchManager({ providers: { mock: noCancel }, defaultProvider: 'mock' });

  await assert.rejects(() => withoutCancel.cancel({ id: 'x', provider: 'mock' }), BatchCapabilityError);
  void batch;
});

test('an idempotency key replays instead of submitting twice', async () => {
  const provider = new MockBatchProvider();
  const batch = new BatchManager({ providers: { mock: provider }, defaultProvider: 'mock', pollIntervalMs: 1 });

  const first = await (await batch.submit({ items: items('a'), idempotencyKey: 'run-1' })).result();
  const second = await (await batch.submit({ items: items('a'), idempotencyKey: 'run-1' })).result();

  assert.equal(provider.submitted.size, 1, 'an ambiguous retry must not double-charge');
  assert.equal(second.ref.id, first.ref.id);
});

test('registration rejects an incomplete provider', () => {
  const batch = new BatchManager();
  assert.throws(() => batch.registerBatchProvider('', new MockBatchProvider()), BatchValidationError);
  assert.throws(() => batch.registerBatchProvider('bad', {} as never), BatchValidationError);
  batch.registerBatchProvider('mock', new MockBatchProvider());
  assert.deepEqual(batch.listBatchProviders(), ['mock']);
  assert.equal(batch.hasBatchProvider('mock'), true);
});

test('terminal statuses are classified correctly', () => {
  assert.equal(isTerminalBatchStatus('completed'), true);
  assert.equal(isTerminalBatchStatus('failed'), true);
  assert.equal(isTerminalBatchStatus('cancelled'), true);
  assert.equal(isTerminalBatchStatus('expired'), true);
  assert.equal(isTerminalBatchStatus('in_progress'), false);
  assert.equal(isTerminalBatchStatus('validating'), false);
});

// ── OpenAI adapter ─────────────────────────────────────────────────

test('the OpenAI adapter uploads JSONL and creates a batch', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const provider = new OpenAIBatchProvider({
    apiKey: 'key',
    fetch: jsonFetch({ '/files': { id: 'file-1' }, '/batches': { id: 'batch-1', status: 'validating' } }, (url, init) =>
      seen.push({ url, init }),
    ),
  });

  const ref = await provider.submit({ items: items('a', 'b') }, context());

  assert.equal(ref.id, 'batch-1');
  assert.equal(ref.provider, 'openai');
  assert.equal(ref.metadata?.inputFileId, 'file-1');
  assert.ok(seen[0]?.url.endsWith('/files'));
  assert.ok(seen[1]?.url.endsWith('/batches'));
  const batchBody = JSON.parse(String(seen[1]?.init.body));
  assert.equal(batchBody.completion_window, '24h');
  assert.equal(batchBody.input_file_id, 'file-1');
});

test('the OpenAI adapter maps status and counts', async () => {
  const provider = new OpenAIBatchProvider({
    apiKey: 'key',
    fetch: jsonFetch({
      '/batches/batch-1': {
        id: 'batch-1',
        status: 'in_progress',
        request_counts: { total: 10, completed: 4, failed: 1 },
        created_at: 1_700_000_000,
      },
    }),
  });

  const state = await provider.poll({ id: 'batch-1', provider: 'openai' }, context());
  assert.equal(state.status, 'in_progress');
  assert.deepEqual(state.counts, { total: 10, completed: 4, failed: 1 });
  assert.equal(state.createdAt, new Date(1_700_000_000_000).toISOString());
});

test('the OpenAI adapter parses JSONL output into items', async () => {
  const output = [
    JSON.stringify({
      custom_id: 'a',
      response: {
        status_code: 200,
        body: {
          model: 'gpt-5.4-mini',
          choices: [{ message: { content: 'answer a' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        },
      },
    }),
    JSON.stringify({ custom_id: 'b', error: { message: 'item exploded', code: 'server_error' } }),
  ].join('\n');

  const provider = new OpenAIBatchProvider({
    apiKey: 'key',
    fetch: jsonFetch({
      '/files/out-1/content': output,
      '/batches/batch-1': { id: 'batch-1', status: 'completed', output_file_id: 'out-1' },
    }),
  });

  const results = await provider.results({ id: 'batch-1', provider: 'openai' }, context());

  assert.equal(results.length, 2);
  assert.equal(results[0]?.response?.content, 'answer a');
  assert.equal(results[0]?.response?.meta.usage?.inputTokens, 12);
  assert.equal(results[1]?.error?.code, 'server_error');
});

test('the OpenAI adapter surfaces an HTTP failure', async () => {
  const provider = new OpenAIBatchProvider({
    apiKey: 'key',
    fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => provider.poll({ id: 'batch-1', provider: 'openai' }, context()),
    BatchProviderResponseError,
  );
});

// ── Anthropic adapter ──────────────────────────────────────────────

test('the Anthropic adapter lifts the system prompt out of messages', async () => {
  let body: { requests: Array<{ params: Record<string, unknown> }> } | undefined;
  const provider = new AnthropicBatchProvider({
    apiKey: 'key',
    fetch: jsonFetch({ '/messages/batches': { id: 'msgbatch-1', processing_status: 'in_progress' } }, (_url, init) => {
      body = JSON.parse(String(init.body));
    }),
  });

  await provider.submit(
    {
      items: [
        {
          customId: 'a',
          request: {
            model: 'claude-sonnet-4.5',
            messages: [
              { role: 'system', content: 'Be terse.' },
              { role: 'user', content: 'Hello' },
            ],
          },
        },
      ],
    },
    context(),
  );

  const params = body?.requests[0]?.params;
  assert.equal(params?.system, 'Be terse.');
  assert.deepEqual(params?.messages, [{ role: 'user', content: 'Hello' }]);
});

test('the Anthropic adapter maps ended to completed and sums counts', async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: 'key',
    fetch: jsonFetch({
      '/messages/batches/msgbatch-1': {
        id: 'msgbatch-1',
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 8, errored: 1, canceled: 1, expired: 0 },
      },
    }),
  });

  const state = await provider.poll({ id: 'msgbatch-1', provider: 'anthropic' }, context());
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.counts, { total: 10, completed: 8, failed: 2 });
});

test('the Anthropic adapter parses succeeded and errored results', async () => {
  const output = [
    JSON.stringify({
      custom_id: 'a',
      result: {
        type: 'succeeded',
        message: {
          model: 'claude-sonnet-4.5',
          content: [{ type: 'text', text: 'answer a' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 4 },
        },
      },
    }),
    JSON.stringify({ custom_id: 'b', result: { type: 'errored', error: { type: 'overloaded', message: 'busy' } } }),
    JSON.stringify({ custom_id: 'c', result: { type: 'expired' } }),
  ].join('\n');

  const provider = new AnthropicBatchProvider({
    apiKey: 'key',
    fetch: jsonFetch({ '/messages/batches/msgbatch-1/results': output }),
  });

  const results = await provider.results({ id: 'msgbatch-1', provider: 'anthropic' }, context());

  assert.equal(results[0]?.response?.content, 'answer a');
  assert.equal(results[0]?.response?.meta.usage?.outputTokens, 4);
  assert.equal(results[1]?.error?.code, 'overloaded');
  assert.equal(results[2]?.error?.code, 'expired', 'an expired item is an error, not an empty success');
});

test('both hosted adapters declare the discounted tier', () => {
  assert.equal(new OpenAIBatchProvider({ apiKey: 'k' }).info.capabilities.discount, 0.5);
  assert.equal(new AnthropicBatchProvider({ apiKey: 'k' }).info.capabilities.discount, 0.5);
});
