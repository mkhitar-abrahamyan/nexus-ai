import type { CompletionRequest, Message, ToolDefinition } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import { generateRequestId } from '../utils/ids.js';
import {
  createAbortProviderError,
  toNexusProviderError,
  type NexusProviderErrorOptions,
} from './errors.js';

export interface ProviderInfo {
  name: string;
  isLocal: boolean;
}

export abstract class BaseProvider {
  abstract readonly info: ProviderInfo;

  abstract complete(request: CompletionRequest): Promise<NexusResponse>;
  abstract stream(request: CompletionRequest): NexusStream;

  async healthCheck(): Promise<boolean> {
    return true;
  }

  protected createBaseResponse(provider: string, model: string): NexusResponse {
    return {
      content: '',
      role: 'assistant',
      finishReason: 'stop',
      meta: {
        requestId: generateRequestId(),
        providerUsed: provider,
        modelUsed: model,
        latencyMs: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensSaved: 0,
        estimatedCost: '$0.00',
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }

  protected extractTextContent(messages: Message[]): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({
      role: msg.role,
      content: typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((p) => p.type === 'text')
            .map((p) => (p as { type: 'text'; text: string }).text)
            .join('\n'),
    }));
  }

  protected formatTools(tools?: ToolDefinition[]): unknown[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  protected normalizeProviderError(
    error: unknown,
    request: CompletionRequest,
    overrides: Partial<NexusProviderErrorOptions> = {},
  ): Error {
    return toNexusProviderError(error, {
      provider: this.info.name,
      model: request.model,
      ...overrides,
    });
  }

  protected throwIfAborted(request: CompletionRequest): void {
    if (request.signal?.aborted) {
      throw createAbortProviderError(this.info.name, request.model, request.signal.reason);
    }
  }

  protected createStream(generator: () => AsyncGenerator<StreamChunk>, signal?: AbortSignal): NexusStream {
    let aborted = false;
    const abort = () => {
      aborted = true;
    };

    if (signal) {
      if (signal.aborted) aborted = true;
      else signal.addEventListener('abort', abort, { once: true });
    }

    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
    };

    const stream: NexusStream = {
      [Symbol.asyncIterator]() {
        const gen = generator();
        return {
          async next() {
            if (aborted || signal?.aborted) {
              cleanup();
              return { done: true, value: undefined as unknown as StreamChunk };
            }
            const result = await gen.next();
            if (result.done) cleanup();
            return result;
          },
          async return() {
            aborted = true;
            cleanup();
            return { done: true, value: undefined as unknown as StreamChunk };
          },
          async throw(e: unknown) {
            aborted = true;
            cleanup();
            return gen.throw(e);
          },
        };
      },
      abort() {
        aborted = true;
        cleanup();
      },
    };

    return stream;
  }
}

export {
  NexusProviderError,
  type NexusProviderErrorCategory,
  type NexusProviderErrorOptions,
} from './errors.js';
