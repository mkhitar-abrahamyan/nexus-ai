import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseProvider } from '../src/providers/base.js';
import { NexusProviderError } from '../src/providers/errors.js';
import { FailoverExecutor } from '../src/router/failover.js';
import type { RouteDecision } from '../src/router/types.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../src/types/response.js';

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'mock/model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function response(content: string): NexusResponse {
  return {
    content,
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: 'test-request',
      providerUsed: 'mock',
      modelUsed: 'mock/model',
      latencyMs: 0,
      tokensInput: 1,
      tokensOutput: 1,
      tokensSaved: 0,
      estimatedCost: '$0.00',
      cacheHit: false,
      guardrailsApplied: [],
    },
  };
}

function decision(fallbacks: RouteDecision['fallbacks'] = []): RouteDecision {
  return {
    providerName: 'mock',
    model: 'mock/model',
    reason: 'regression test',
    fallbacks,
  };
}

function emptyStream(): NexusStream {
  return {
    async *[Symbol.asyncIterator]() {},
    abort() {},
  };
}

function retryOptions(timeoutMs: number) {
  return {
    timeoutMs,
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoff: 'fixed' as const,
      retryOn: ['timeout' as const],
    },
  };
}

class TimeoutThenCompleteProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };
  readonly signals: AbortSignal[] = [];
  calls = 0;
  active = 0;
  maxActive = 0;

  async complete(input: CompletionRequest): Promise<NexusResponse> {
    this.calls += 1;
    this.signals.push(assertSignal(input.signal));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    if (this.calls > 1) {
      this.active -= 1;
      return response('recovered');
    }

    return new Promise<NexusResponse>((_resolve, reject) => {
      const signal = assertSignal(input.signal);
      const abort = () => {
        this.active -= 1;
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  stream(): NexusStream {
    return emptyStream();
  }
}

class AbortOnlyCompleteProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };
  receivedSignal?: AbortSignal;
  calls = 0;

  async complete(input: CompletionRequest): Promise<NexusResponse> {
    this.calls += 1;
    const signal = assertSignal(input.signal);
    this.receivedSignal = signal;
    return new Promise<NexusResponse>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  stream(): NexusStream {
    return emptyStream();
  }
}

class TimeoutThenTextProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };
  readonly signals: AbortSignal[] = [];
  streamCalls = 0;
  active = 0;
  maxActive = 0;

  async complete(): Promise<NexusResponse> {
    return response('unused');
  }

  stream(input: CompletionRequest): NexusStream {
    this.streamCalls += 1;
    const call = this.streamCalls;
    const signal = assertSignal(input.signal);
    this.signals.push(signal);
    let returned = false;

    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<StreamChunk>> => {
          if (returned) return { done: true, value: undefined };
          this.active += 1;
          this.maxActive = Math.max(this.maxActive, this.active);

          if (call > 1) {
            returned = true;
            this.active -= 1;
            return { done: false, value: { type: 'text', content: 'recovered' } };
          }

          return new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
            const abort = () => {
              this.active -= 1;
              reject(signal.reason);
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        },
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
      abort() {},
    };
  }
}

class PartialThenTimeoutProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };
  streamCalls = 0;

  async complete(): Promise<NexusResponse> {
    return response('unused');
  }

  stream(input: CompletionRequest): NexusStream {
    this.streamCalls += 1;
    const signal = assertSignal(input.signal);
    let index = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<StreamChunk>> => {
          if (index === 0) {
            index += 1;
            return { done: false, value: { type: 'text', content: 'partial' } };
          }
          return new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        },
        return: async () => ({ done: true, value: undefined }),
      }),
      abort() {},
    };
  }
}

class CountingBackupProvider extends BaseProvider {
  readonly info = { name: 'backup', isLocal: true };
  streamCalls = 0;

  async complete(): Promise<NexusResponse> {
    return response('backup');
  }

  stream(): NexusStream {
    this.streamCalls += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', content: 'backup' } satisfies StreamChunk;
      },
      abort() {},
    };
  }
}

class HangingStreamProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };
  receivedSignal?: AbortSignal;

  async complete(): Promise<NexusResponse> {
    return response('unused');
  }

  stream(input: CompletionRequest): NexusStream {
    const signal = assertSignal(input.signal);
    this.receivedSignal = signal;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          }),
        return: async () => ({ done: true, value: undefined }),
      }),
      abort() {},
    };
  }
}

class BreakAwareStreamProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };
  receivedSignal?: AbortSignal;
  abortCalls = 0;
  returnCalls = 0;

  async complete(): Promise<NexusResponse> {
    return response('unused');
  }

  stream(input: CompletionRequest): NexusStream {
    this.receivedSignal = assertSignal(input.signal);
    let emitted = false;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<StreamChunk>> => {
          if (emitted) return new Promise(() => {});
          emitted = true;
          return { done: false, value: { type: 'text', content: 'first' } };
        },
        return: async () => {
          this.returnCalls += 1;
          return { done: true, value: undefined };
        },
      }),
      abort: () => {
        this.abortCalls += 1;
      },
    };
  }
}

class CreateStreamLifecycleProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };
  finalized = 0;

  async complete(): Promise<NexusResponse> {
    return response('unused');
  }

  stream(input: CompletionRequest): NexusStream {
    const self = this;
    return this.createStream(async function* () {
      try {
        yield { type: 'text', content: 'first' } satisfies StreamChunk;
        yield { type: 'text', content: 'second' } satisfies StreamChunk;
      } finally {
        self.finalized += 1;
      }
    }, input.signal);
  }
}

function assertSignal(signal: AbortSignal | undefined): AbortSignal {
  assert.ok(signal, 'provider request must receive an AbortSignal');
  return signal;
}

test('completion timeout aborts the provider, then retries without overlap', async () => {
  const provider = new TimeoutThenCompleteProvider();
  const caller = new AbortController();
  const result = await new FailoverExecutor().complete(
    request({ signal: caller.signal, timeoutMs: 15 }),
    decision(),
    new Map([['mock', provider]]),
    retryOptions(1_000),
  );

  assert.equal(result.content, 'recovered');
  assert.equal(provider.calls, 2);
  assert.equal(provider.maxActive, 1);
  assert.notEqual(provider.signals[0], caller.signal);
  assert.notEqual(provider.signals[0], provider.signals[1]);
  assert.equal(provider.signals[0].aborted, true);
  assert.ok(provider.signals[0].reason instanceof NexusProviderError);
  assert.equal(provider.signals[0].reason.category, 'timeout');
  assert.ok(result.meta.guardrailsApplied.includes('provider-retry-1'));
});

test('caller abort propagates through a linked provider signal and remains non-retryable', async () => {
  const provider = new AbortOnlyCompleteProvider();
  const caller = new AbortController();
  const completion = new FailoverExecutor().complete(
    request({ signal: caller.signal }),
    decision(),
    new Map([['mock', provider]]),
    retryOptions(1_000),
  );

  caller.abort('caller cancelled');

  await assert.rejects(completion, (error) => {
    assert.ok(error instanceof NexusProviderError);
    assert.equal(error.category, 'abort');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(provider.calls, 1);
  assert.notEqual(provider.receivedSignal, caller.signal);
  assert.equal(provider.receivedSignal?.aborted, true);
});

test('global timeout applies to streams and retries only after the aborted attempt settles', async () => {
  const provider = new TimeoutThenTextProvider();
  const chunks: StreamChunk[] = [];
  for await (const chunk of new FailoverExecutor().stream(
    request(),
    decision(),
    new Map([['mock', provider]]),
    retryOptions(15),
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [{ type: 'text', content: 'recovered' }]);
  assert.equal(provider.streamCalls, 2);
  assert.equal(provider.maxActive, 1);
  assert.notEqual(provider.signals[0], provider.signals[1]);
  assert.equal(provider.signals[0].aborted, true);
  assert.ok(provider.signals[0].reason instanceof NexusProviderError);
  assert.equal(provider.signals[0].reason.category, 'timeout');
});

test('stream timeout after partial output does not retry or splice in a fallback', async () => {
  const provider = new PartialThenTimeoutProvider();
  const backup = new CountingBackupProvider();
  const chunks: StreamChunk[] = [];
  for await (const chunk of new FailoverExecutor().stream(
    request({ timeoutMs: 15 }),
    decision([{ providerName: 'backup', model: 'backup/model' }]),
    new Map<string, BaseProvider>([
      ['mock', provider],
      ['backup', backup],
    ]),
    retryOptions(1_000),
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['text', 'error'],
  );
  assert.equal(chunks[0].content, 'partial');
  assert.match(chunks[1].error ?? '', /timed out after 15ms/);
  assert.equal(provider.streamCalls, 1);
  assert.equal(backup.streamCalls, 0);
});

test('aborting the returned stream cancels the active provider and ends cleanly', async () => {
  const provider = new HangingStreamProvider();
  const stream = new FailoverExecutor().stream(request(), decision(), new Map([['mock', provider]]));
  const iterator = stream[Symbol.asyncIterator]();
  const next = iterator.next();

  stream.abort();

  assert.deepEqual(await next, { done: true, value: undefined });
  assert.equal(provider.receivedSignal?.aborted, true);
});

test('breaking stream iteration aborts the linked provider signal and closes its iterator', async () => {
  const provider = new BreakAwareStreamProvider();
  const stream = new FailoverExecutor().stream(request(), decision(), new Map([['mock', provider]]));

  for await (const chunk of stream) {
    assert.equal(chunk.content, 'first');
    break;
  }

  assert.equal(provider.receivedSignal?.aborted, true);
  assert.ok(provider.receivedSignal?.reason instanceof NexusProviderError);
  assert.equal(provider.receivedSignal?.reason.category, 'abort');
  assert.ok(provider.abortCalls >= 1);
  assert.equal(provider.returnCalls, 1);
});

test('BaseProvider stream return and abort close the underlying async generator', async () => {
  const provider = new CreateStreamLifecycleProvider();
  const returnedStream = provider.stream(request());
  const returnedIterator = returnedStream[Symbol.asyncIterator]();

  assert.equal((await returnedIterator.next()).value.content, 'first');
  assert.ok(returnedIterator.return);
  await returnedIterator.return();
  assert.equal(provider.finalized, 1);

  const abortedStream = provider.stream(request());
  const abortedIterator = abortedStream[Symbol.asyncIterator]();
  assert.equal((await abortedIterator.next()).value.content, 'first');
  abortedStream.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(provider.finalized, 2);
  assert.deepEqual(await abortedIterator.next(), { done: true, value: undefined });
});
