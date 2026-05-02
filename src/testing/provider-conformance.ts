import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, StreamChunk } from '../types/response.js';
import type { BaseProvider } from '../providers/base.js';

export interface ProviderConformanceCase {
  name: string;
  request: CompletionRequest;
  validate: (response: NexusResponse) => boolean | Promise<boolean>;
}

export interface ProviderConformanceResult {
  providerName: string;
  model: string;
  caseName: string;
  completeOk: boolean;
  streamOk?: boolean;
  healthOk?: boolean;
  error?: string;
}

export const PROVIDER_CONFORMANCE_FIXTURES: Record<string, ProviderConformanceCase[]> = {
  openai: baseFixtures('gpt-5.4-mini'),
  anthropic: baseFixtures('claude-sonnet-4'),
  google: baseFixtures('gemini-2.5-flash'),
  groq: baseFixtures('groq/openai/gpt-oss-20b'),
  mistral: baseFixtures('mistral/mistral-small-2603'),
  cohere: baseFixtures('cohere/command-r7b-12-2024'),
  ollama: baseFixtures('ollama/llama3.2'),
  openrouter: baseFixtures('openrouter/openai/gpt-5.4-mini'),
};

export async function runProviderConformance(
  providerName: string,
  provider: BaseProvider,
  options: {
    model?: string;
    fixtures?: ProviderConformanceCase[];
    testStream?: boolean;
    testHealth?: boolean;
  } = {},
): Promise<ProviderConformanceResult[]> {
  const fixtures = options.fixtures || PROVIDER_CONFORMANCE_FIXTURES[providerName] || baseFixtures(options.model || 'auto');
  const results: ProviderConformanceResult[] = [];
  const healthOk = options.testHealth ? await provider.healthCheck() : undefined;

  for (const fixture of fixtures) {
    const request = {
      ...fixture.request,
      model: options.model || fixture.request.model,
    };
    try {
      const response = await provider.complete(request);
      const completeOk = await fixture.validate(response);
      let streamOk: boolean | undefined;

      if (options.testStream) {
        streamOk = await validateStream(provider.stream(request));
      }

      results.push({
        providerName,
        model: request.model,
        caseName: fixture.name,
        completeOk,
        streamOk,
        healthOk,
      });
    } catch (error) {
      results.push({
        providerName,
        model: request.model,
        caseName: fixture.name,
        completeOk: false,
        healthOk,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function baseFixtures(model: string): ProviderConformanceCase[] {
  return [
    {
      name: 'basic-text-completion',
      request: {
        model,
        messages: [{ role: 'user', content: 'Reply with the word ok.' }],
        temperature: 0,
        maxTokens: 16,
      },
      validate: (response) => response.role === 'assistant' && typeof response.content === 'string',
    },
    {
      name: 'json-response-shape',
      request: {
        model,
        messages: [{ role: 'user', content: 'Return JSON with {"ok": true}.' }],
        temperature: 0,
        maxTokens: 64,
        responseFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          },
        },
      },
      validate: (response) => {
        try {
          const parsed = JSON.parse(response.content);
          return typeof parsed.ok === 'boolean';
        } catch {
          return false;
        }
      },
    },
  ];
}

async function validateStream(stream: AsyncIterable<StreamChunk>): Promise<boolean> {
  for await (const chunk of stream) {
    if (chunk.type === 'text' || chunk.type === 'done' || chunk.type === 'tool_call') return true;
    if (chunk.type === 'error') return false;
  }
  return false;
}
