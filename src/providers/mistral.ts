import { OpenAIProvider } from './openai.js';
import type { MistralProviderConfig } from '../types/config.js';
import type { ProviderCallContext } from '../types/lifecycle.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream, ResponseMeta, StreamChunk } from '../types/response.js';
import { priceUsage } from '../core/usage.js';

/** Mistral's chat API. */
export class MistralProvider extends OpenAIProvider {
  /** Always `mistral`, hosted. */
  readonly info = { name: 'mistral', isLocal: false };

  constructor(config: MistralProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.mistral.ai/v1',
    });
  }

  /** Runs one completion. */
  async complete(request: CompletionRequest, context?: ProviderCallContext): Promise<NexusResponse> {
    const response = await super.complete({ ...request, model: this.stripPrefix(request.model) }, context);
    return {
      ...response,
      meta: {
        ...this.withProviderMeta(response.meta, request.model),
        modelUsed: response.meta.modelUsed || this.stripPrefix(request.model),
      },
    };
  }

  /** Streams one completion. */
  stream(request: CompletionRequest, context?: ProviderCallContext): NexusStream {
    const stream = super.stream({ ...request, model: this.stripPrefix(request.model) }, context);
    const self = this;
    return this.createStream(async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'done') {
          yield { ...chunk, meta: self.withProviderMeta(chunk.meta ?? {}, request.model) } satisfies StreamChunk;
          continue;
        }
        yield chunk;
      }
    }, request.signal);
  }

  private stripPrefix(model: string): string {
    return model.startsWith('mistral/') ? model.slice('mistral/'.length) : model;
  }

  /**
   * Names Mistral as the provider and prices the call against its registry entry, which is filed
   * under the `mistral/` prefix the API does not accept.
   */
  private withProviderMeta<M extends Partial<ResponseMeta>>(meta: M, model: string): M {
    const usage = meta.usage;
    const registryName = model.startsWith('mistral/') ? model : `mistral/${model}`;
    return {
      ...meta,
      providerUsed: 'mistral',
      ...(usage && meta.cost?.basis !== 'reported' ? { cost: priceUsage({ model: registryName, usage }) } : {}),
    };
  }
}
