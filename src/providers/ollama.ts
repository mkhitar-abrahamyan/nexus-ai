import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import type { OllamaProviderConfig } from '../types/config.js';
import { generateRequestId } from '../utils/ids.js';

export class OllamaProvider extends BaseProvider {
  readonly info: ProviderInfo = { name: 'ollama', isLocal: true };
  private client: any;
  private config: OllamaProviderConfig;

  constructor(config: OllamaProviderConfig) {
    super();
    this.config = config;
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { Ollama } = await import('ollama');
      this.client = new Ollama({ host: this.config.baseUrl || 'http://localhost:11434' });
    }
    return this.client;
  }

  private formatMessages(messages: Message[]): any[] {
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

  private extractModel(model: string): string {
    // Support "ollama/llama3.2" syntax — strip prefix
    if (model.startsWith('ollama/')) return model.slice(7);
    return model;
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const client = await this.getClient();
    const startTime = Date.now();
    const model = this.extractModel(request.model);

    const result = await client.chat({
      model,
      messages: this.formatMessages(request.messages),
      format: request.responseFormat?.type === 'json' ? 'json' : request.responseFormat?.schema,
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        stop: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
      },
    });

    const latency = Date.now() - startTime;

    return {
      content: result.message?.content || '',
      role: 'assistant',
      finishReason: 'stop',
      meta: {
        requestId: generateRequestId(),
        providerUsed: 'ollama',
        modelUsed: model,
        latencyMs: latency,
        tokensInput: result.prompt_eval_count || 0,
        tokensOutput: result.eval_count || 0,
        tokensSaved: 0,
        estimatedCost: '$0.00',
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }

  stream(request: CompletionRequest): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      const client = await self.getClient();
      const startTime = Date.now();
      const model = self.extractModel(request.model);

      const stream = await client.chat({
        model,
        messages: self.formatMessages(request.messages),
        stream: true,
        format: request.responseFormat?.type === 'json' ? 'json' : request.responseFormat?.schema,
        options: {
          temperature: request.temperature,
          top_p: request.topP,
        },
      });

      for await (const chunk of stream) {
        if (chunk.message?.content) {
          yield { type: 'text', content: chunk.message.content } satisfies StreamChunk;
        }

        if (chunk.done) {
          yield {
            type: 'done',
            meta: {
              requestId: generateRequestId(),
              providerUsed: 'ollama',
              modelUsed: model,
              latencyMs: Date.now() - startTime,
              tokensInput: chunk.prompt_eval_count || 0,
              tokensOutput: chunk.eval_count || 0,
              tokensSaved: 0,
              estimatedCost: '$0.00',
              cacheHit: false,
              guardrailsApplied: [],
            },
          } satisfies StreamChunk;
        }
      }
    });
  }
}
