import type { CompletionRequest, Message, ToolDefinition } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import { generateRequestId } from '../utils/ids.js';
import { createAbortProviderError, type NexusProviderErrorOptions, toNexusProviderError } from './errors.js';

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
      content:
        typeof msg.content === 'string'
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
    let listening = false;
    const activeGenerators = new Set<AsyncGenerator<StreamChunk>>();
    const closingGenerators = new Map<AsyncGenerator<StreamChunk>, Promise<IteratorResult<StreamChunk>>>();

    const cleanup = () => {
      if (!listening) return;
      signal?.removeEventListener('abort', abort);
      listening = false;
    };

    const finishGenerator = (gen: AsyncGenerator<StreamChunk>) => {
      activeGenerators.delete(gen);
      closingGenerators.delete(gen);
      if (activeGenerators.size === 0) cleanup();
    };

    const closeGenerator = (gen: AsyncGenerator<StreamChunk>): Promise<IteratorResult<StreamChunk>> => {
      const closing = closingGenerators.get(gen);
      if (closing) return closing;

      const close = (async () => {
        try {
          return await gen.return(undefined);
        } finally {
          finishGenerator(gen);
        }
      })();
      closingGenerators.set(gen, close);
      return close;
    };

    const closeActiveGenerators = () => {
      for (const gen of activeGenerators) {
        void closeGenerator(gen).catch(() => {
          // abort() cannot report asynchronous cleanup failures.
        });
      }
    };

    const abort = () => {
      aborted = true;
      cleanup();
      closeActiveGenerators();
    };

    const listenForAbort = () => {
      if (!signal || listening || aborted) return;
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      listening = true;
    };

    listenForAbort();

    const stream: NexusStream = {
      [Symbol.asyncIterator]() {
        const gen = generator();
        activeGenerators.add(gen);
        listenForAbort();
        return {
          async next() {
            if (aborted || signal?.aborted) {
              await closeGenerator(gen);
              return { done: true, value: undefined as unknown as StreamChunk };
            }
            try {
              const result = await gen.next();
              if (result.done) finishGenerator(gen);
              return result;
            } catch (error) {
              finishGenerator(gen);
              throw error;
            }
          },
          async return() {
            aborted = true;
            cleanup();
            closeActiveGenerators();
            return closeGenerator(gen);
          },
          async throw(e: unknown) {
            aborted = true;
            cleanup();
            try {
              const result = await gen.throw(e);
              if (result.done) finishGenerator(gen);
              return result;
            } catch (error) {
              finishGenerator(gen);
              throw error;
            }
          },
        };
      },
      abort() {
        abort();
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
