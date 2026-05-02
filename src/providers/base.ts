import type { CompletionRequest, Message, ToolDefinition } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import { generateRequestId } from '../utils/ids.js';

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

  protected createStream(generator: () => AsyncGenerator<StreamChunk>): NexusStream {
    let aborted = false;

    const stream: NexusStream = {
      [Symbol.asyncIterator]() {
        const gen = generator();
        return {
          async next() {
            if (aborted) return { done: true, value: undefined as unknown as StreamChunk };
            return gen.next();
          },
          async return() {
            aborted = true;
            return { done: true, value: undefined as unknown as StreamChunk };
          },
          async throw(e: unknown) {
            aborted = true;
            return gen.throw(e);
          },
        };
      },
      abort() {
        aborted = true;
      },
    };

    return stream;
  }
}
