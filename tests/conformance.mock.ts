import {
  BaseProvider,
  runProviderConformance,
  type CompletionRequest,
  type NexusResponse,
  type NexusStream,
  type StreamChunk,
} from '../src/index.js';

class MockProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const base = this.createBaseResponse('mock', request.model);
    const wantsJson = request.responseFormat?.type === 'json' || request.responseFormat?.type === 'json_schema';
    return {
      ...base,
      content: wantsJson ? JSON.stringify({ ok: true }) : 'ok',
      meta: {
        ...base.meta,
        latencyMs: 1,
        tokensInput: 4,
        tokensOutput: 1,
      },
    };
  }

  stream(): NexusStream {
    return this.createStream(async function* () {
      yield { type: 'text', content: 'ok' } satisfies StreamChunk;
      yield { type: 'done' } satisfies StreamChunk;
    });
  }
}

const results = await runProviderConformance('mock', new MockProvider(), {
  model: 'mock-model',
  testStream: true,
  testHealth: true,
});

const failed = results.filter((result) => !result.completeOk || result.streamOk === false || result.healthOk === false);
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(results, null, 2));
