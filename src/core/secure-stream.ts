import type { SecurityPipeline } from '../security/index.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';

export function protectStreamOutput(stream: NexusStream, security: SecurityPipeline): NexusStream {
  let aborted = false;

  return {
    async *[Symbol.asyncIterator]() {
      let buffered = '';

      for await (const chunk of stream) {
        if (aborted) return;

        if (chunk.type !== 'text' || !chunk.content) {
          yield chunk;
          continue;
        }

        buffered += chunk.content;
        const pseudoResponse: NexusResponse = {
          content: buffered,
          role: 'assistant',
          finishReason: 'stop',
          meta: {
            requestId: chunk.meta?.requestId || 'stream',
            providerUsed: chunk.meta?.providerUsed || 'unknown',
            modelUsed: chunk.meta?.modelUsed || 'unknown',
            latencyMs: chunk.meta?.latencyMs || 0,
            tokensInput: chunk.meta?.tokensInput || 0,
            tokensOutput: chunk.meta?.tokensOutput || 0,
            tokensSaved: chunk.meta?.tokensSaved || 0,
            estimatedCost: chunk.meta?.estimatedCost || '$0.00',
            cacheHit: chunk.meta?.cacheHit || false,
            guardrailsApplied: chunk.meta?.guardrailsApplied || [],
          },
        };
        const protectedOutput = security.protectOutput(pseudoResponse).value.content;
        const safeDelta = protectedOutput.slice(Math.max(0, protectedOutput.length - chunk.content.length));

        yield { ...chunk, content: safeDelta } satisfies StreamChunk;
      }
    },
    abort() {
      aborted = true;
      stream.abort();
    },
  };
}
