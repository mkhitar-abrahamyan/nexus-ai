import type { SecurityPipeline } from '../security/index.js';
import { redactSensitiveText } from '../security/output-guard.js';
import type { NexusResponse, NexusStream, ResponseMeta, StreamChunk, ToolCall } from '../types/response.js';

// Output patterns such as private-key blocks can be arbitrarily long. Holding
// text until the guard has seen the complete output is the only way to promise
// that a match split across chunks is never partially emitted. The hard cap
// keeps that correctness-first strategy from becoming an unbounded allocation.
const MAX_BUFFERED_STREAM_BYTES = 1_048_576;
const MAX_BUFFERED_STREAM_CHUNKS = 100_000;

export function protectStreamOutput(
  stream: NexusStream,
  security: SecurityPipeline,
  requestSignal?: AbortSignal,
): NexusStream {
  let aborted = false;

  return {
    async *[Symbol.asyncIterator]() {
      const chunks: StreamChunk[] = [];
      let bufferedText = '';
      let bufferedBytes = 0;
      const bufferedToolCalls: ToolCall[] = [];

      for await (const chunk of stream) {
        if (aborted || requestSignal?.aborted) {
          stream.abort();
          return;
        }

        chunks.push(chunk);
        if (chunks.length > MAX_BUFFERED_STREAM_CHUNKS) {
          stream.abort();
          throw new Error('NexusAI security stream chunk limit exceeded before output validation');
        }

        if (chunk.type === 'text' && chunk.content) {
          bufferedText += chunk.content;
          bufferedBytes += Buffer.byteLength(chunk.content);
        } else if (chunk.type === 'error' && chunk.error) {
          bufferedBytes += Buffer.byteLength(chunk.error);
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          bufferedBytes += Buffer.byteLength(chunk.toolCall.function.arguments);
          bufferedToolCalls.push(chunk.toolCall);
        }

        if (bufferedBytes > MAX_BUFFERED_STREAM_BYTES) {
          stream.abort();
          throw new Error(
            `NexusAI security stream buffer exceeded ${MAX_BUFFERED_STREAM_BYTES} bytes before output validation`,
          );
        }
      }

      if (aborted || requestSignal?.aborted) return;
      if (!bufferedText && bufferedToolCalls.length === 0) {
        for (const chunk of chunks) {
          if (aborted || requestSignal?.aborted) return;
          yield sanitizeDiagnosticChunk(chunk);
        }
        return;
      }

      const sourceMeta = mergeStreamMeta(chunks);
      const protectedOutput = security.protectOutput(toPseudoResponse(bufferedText, bufferedToolCalls, sourceMeta));

      // This happens before the first downstream yield, so forbidden output is
      // never observable even when the triggering term spans provider chunks.
      security.assertOutputSafe(protectedOutput);

      const safeText = protectedOutput.value.content;
      const safeToolCalls = protectedOutput.value.toolCalls || [];
      const applied = protectedOutput.value.meta.guardrailsApplied;
      const textIndexes = chunks
        .map((chunk, index) => (chunk.type === 'text' && chunk.content ? index : -1))
        .filter((index) => index >= 0);
      const lastTextIndex = textIndexes.at(-1);
      let safeOffset = 0;
      let safeToolCallIndex = 0;

      for (let index = 0; index < chunks.length; index += 1) {
        if (aborted || requestSignal?.aborted) return;
        const chunk = chunks[index];

        if (chunk.type === 'text' && chunk.content) {
          const remaining = safeText.length - safeOffset;
          const length =
            index === lastTextIndex ? Math.max(0, remaining) : Math.min(chunk.content.length, Math.max(0, remaining));
          const content = safeText.slice(safeOffset, safeOffset + length);
          safeOffset += length;
          if (!content) continue;
          yield {
            ...chunk,
            content,
            meta: withGuardrails(chunk.meta, applied),
          } satisfies StreamChunk;
          continue;
        }

        if (chunk.type === 'done') {
          yield {
            ...chunk,
            meta: withGuardrails(chunk.meta, applied),
          } satisfies StreamChunk;
          continue;
        }

        if (chunk.type === 'tool_call' && chunk.toolCall) {
          const toolCall = safeToolCalls[safeToolCallIndex];
          safeToolCallIndex += 1;
          if (!toolCall) continue;
          yield {
            ...chunk,
            toolCall,
            meta: withGuardrails(chunk.meta, applied),
          } satisfies StreamChunk;
          continue;
        }

        yield sanitizeDiagnosticChunk(chunk);
      }
    },
    abort() {
      aborted = true;
      stream.abort();
    },
  };
}

function toPseudoResponse(content: string, toolCalls: ToolCall[], meta: Partial<ResponseMeta>): NexusResponse {
  return {
    content,
    role: 'assistant',
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    meta: {
      requestId: meta.requestId || 'stream',
      providerUsed: meta.providerUsed || 'unknown',
      modelUsed: meta.modelUsed || 'unknown',
      latencyMs: meta.latencyMs || 0,
      tokensInput: meta.tokensInput || 0,
      tokensOutput: meta.tokensOutput || 0,
      tokensSaved: meta.tokensSaved || 0,
      estimatedCost: meta.estimatedCost || '$0.00',
      cacheHit: meta.cacheHit || false,
      guardrailsApplied: meta.guardrailsApplied || [],
    },
  };
}

function mergeStreamMeta(chunks: StreamChunk[]): Partial<ResponseMeta> {
  const merged: Partial<ResponseMeta> = {};
  for (const chunk of chunks) {
    if (chunk.meta) Object.assign(merged, chunk.meta);
  }
  return merged;
}

function withGuardrails(meta: Partial<ResponseMeta> | undefined, applied: string[]): Partial<ResponseMeta> {
  return {
    ...meta,
    guardrailsApplied: [...new Set([...(meta?.guardrailsApplied || []), ...applied])],
  };
}

function sanitizeDiagnosticChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== 'error' || !chunk.error) return chunk;
  return { ...chunk, error: redactSensitiveText(chunk.error) };
}
