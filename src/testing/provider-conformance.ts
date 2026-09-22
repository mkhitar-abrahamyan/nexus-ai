import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, StreamChunk } from '../types/response.js';
import type { BaseProvider } from '../providers/base.js';

/** One chat-provider conformance case: a request and a check on its response. */
export interface ProviderConformanceCase {
  /** The case's name. */
  name: string;
  /** The request sent. */
  request: CompletionRequest;
  /** Returns true when the response is acceptable. */
  validate: (response: NexusResponse) => boolean | Promise<boolean>;
}

/** The outcome of one chat-provider conformance case. */
export interface ProviderConformanceResult {
  /** The provider checked. */
  providerName: string;
  /** The model used. */
  model: string;
  /** The case. */
  caseName: string;
  /** True when `complete()` returned a response the case accepted. */
  completeOk: boolean;
  /** True when streaming produced usable chunks and no error, when `testStream` is on. */
  streamOk?: boolean;
  /** True when the health check passed, when `testHealth` is on. */
  healthOk?: boolean;
  /** What went wrong, when anything did. */
  error?: string;
}

/** Options for `runProviderConformance()`. */
export interface ProviderConformanceOptions {
  /** Model to use for every case. The provider's own fixtures are used when omitted. */
  model?: string;
  /** Cases to run instead of the defaults. */
  fixtures?: ProviderConformanceCase[];
  /** Also streams each case. Off by default. */
  testStream?: boolean;
  /** Also runs the provider's health check once. Off by default. */
  testHealth?: boolean;
  /** Includes the JSON response-format case. Defaults to true. */
  testJson?: boolean;
  /** Includes the tool-calling case. Off by default. */
  testTools?: boolean;
}

/** Default conformance cases for each bundled chat provider, keyed by provider name. */
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

/**
 * Checks a chat provider against the neutral contract: completion, and optionally streaming,
 * health, JSON output, and tool calls. Runs live requests.
 */
export async function runProviderConformance(
  providerName: string,
  provider: BaseProvider,
  options: ProviderConformanceOptions = {},
): Promise<ProviderConformanceResult[]> {
  const fixtureModel = options.model || 'auto';
  const shouldBuildCustomFixtures = Boolean(options.model || options.testJson === false || options.testTools);
  const fixtures =
    options.fixtures ||
    (shouldBuildCustomFixtures
      ? baseFixtures(fixtureModel, {
          json: options.testJson !== false,
          tools: options.testTools === true,
        })
      : PROVIDER_CONFORMANCE_FIXTURES[providerName] || baseFixtures(fixtureModel));
  const results: ProviderConformanceResult[] = [];
  let healthOk: boolean | undefined;
  let healthError: string | undefined;

  if (options.testHealth) {
    try {
      healthOk = await provider.healthCheck();
    } catch (error) {
      healthOk = false;
      healthError = error instanceof Error ? error.message : String(error);
    }
  }

  for (const fixture of fixtures) {
    const request = {
      ...fixture.request,
      model: options.model || fixture.request.model,
    };
    try {
      const response = await provider.complete(request);
      const completeOk = await fixture.validate(response);
      let streamOk: boolean | undefined;
      let streamError: string | undefined;

      if (options.testStream) {
        try {
          streamOk = await validateStream(provider.stream(request));
        } catch (error) {
          streamOk = false;
          streamError = error instanceof Error ? error.message : String(error);
        }
      }

      results.push({
        providerName,
        model: request.model,
        caseName: fixture.name,
        completeOk,
        streamOk,
        healthOk,
        error: streamError || healthError,
      });
    } catch (error) {
      results.push({
        providerName,
        model: request.model,
        caseName: fixture.name,
        completeOk: false,
        healthOk,
        error: [healthError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' | '),
      });
    }
  }

  return results;
}

function baseFixtures(model: string, options: { json?: boolean; tools?: boolean } = {}): ProviderConformanceCase[] {
  const includeJson = options.json !== false;
  const fixtures: ProviderConformanceCase[] = [
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
  ];

  if (includeJson) {
    fixtures.push({
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
    });
  }

  if (options.tools) {
    fixtures.push({
      name: 'tool-call-normalization',
      request: {
        model,
        messages: [{ role: 'user', content: 'Call the lookup tool with query "ok".' }],
        temperature: 0,
        maxTokens: 96,
        tools: [
          {
            name: 'lookup',
            description: 'Lookup a short query.',
            parameters: {
              type: 'object',
              required: ['query'],
              properties: { query: { type: 'string' } },
            },
          },
        ],
      },
      validate: (response) => {
        return (
          Array.isArray(response.toolCalls) &&
          response.toolCalls.some((toolCall) => toolCall.function.name === 'lookup')
        );
      },
    });
  }

  return fixtures;
}

async function validateStream(stream: AsyncIterable<StreamChunk>): Promise<boolean> {
  let sawUsableChunk = false;
  for await (const chunk of stream) {
    if (chunk.type === 'text' || chunk.type === 'done' || chunk.type === 'tool_call') sawUsableChunk = true;
    if (chunk.type === 'error') return false;
  }
  return sawUsableChunk;
}
