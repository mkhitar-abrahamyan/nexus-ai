import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, ContentPart, Message } from '../types/messages.js';
import type { GoogleProviderConfig } from '../types/config.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import type { ReasoningEffort } from '../types/providers.js';
import { buildMeta, type UsageInput } from '../core/usage.js';
import { generateRequestId } from '../utils/ids.js';
import { createProviderHttpError, toNexusProviderError } from './errors.js';

interface GeminiContentPart {
  text?: string;
  /** Set on reasoning summaries when `includeThoughts` is requested. */
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name?: string;
    args?: unknown;
  };
}

interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiContentPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Thinking budgets per portable effort level, in tokens.
 *
 * Gemini budgets thinking in tokens; `0` disables it and `-1` lets the model decide.
 */
const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
};

/** Gemini counts cached tokens inside `promptTokenCount`, so the cached share is subtracted. */
function geminiUsage(usage: GeminiUsageMetadata | undefined): UsageInput {
  if (!usage) return {};
  const cachedReadTokens = usage.cachedContentTokenCount;
  return {
    inputTokens: Math.max(0, (usage.promptTokenCount || 0) - (cachedReadTokens || 0)),
    outputTokens: usage.candidatesTokenCount || 0,
    cachedReadTokens,
    reasoningTokens: usage.thoughtsTokenCount,
  };
}

export class GoogleProvider extends BaseProvider {
  readonly info: ProviderInfo = { name: 'google', isLocal: false };
  private config: GoogleProviderConfig;

  constructor(config: GoogleProviderConfig) {
    super();
    this.config = config;
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    try {
      this.throwIfAborted(request);
      const startTime = Date.now();
      const model = this.extractModel(request.model);
      const result = await this.generate(model, request, false);
      const latency = Date.now() - startTime;
      const candidate = result.candidates?.[0];
      const content = this.extractText(candidate?.content);
      const toolCalls = this.extractToolCalls(candidate?.content);

      return {
        content,
        role: 'assistant',
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason: toolCalls.length ? 'tool_calls' : this.mapFinishReason(candidate?.finishReason),
        meta: buildMeta({
          provider: 'google',
          model,
          latencyMs: latency,
          ...geminiUsage(result.usageMetadata),
        }),
      };
    } catch (error) {
      throw this.normalizeProviderError(error, request, { model: this.extractModel(request.model) });
    }
  }

  stream(request: CompletionRequest): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      const startTime = Date.now();
      const model = self.extractModel(request.model);
      try {
        self.throwIfAborted(request);
        const response = await self.generate(model, request, true);
        const reader = response.body?.getReader();

        if (!reader) {
          throw toNexusProviderError(new Error('Google stream response did not include a readable body'), {
            provider: 'google',
            model,
            category: 'bad-response',
            retryable: false,
          });
        }

        const decoder = new TextDecoder();
        let buffer = '';
        // Gemini repeats cumulative usage on every chunk; the last one carries the final totals.
        let usage: UsageInput = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const event of events) {
            const data = event
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (!data || data === '[DONE]') continue;

            const parsed = JSON.parse(data) as GeminiGenerateResponse;
            if (parsed.usageMetadata) usage = geminiUsage(parsed.usageMetadata);

            const parts = parsed.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (typeof part.text !== 'string' || !part.text) continue;
              yield { type: part.thought ? 'reasoning' : 'text', content: part.text } satisfies StreamChunk;
            }
          }
        }

        yield {
          type: 'done',
          meta: buildMeta({ provider: 'google', model, latencyMs: Date.now() - startTime, ...usage }),
        } satisfies StreamChunk;
      } catch (error) {
        throw self.normalizeProviderError(error, request, { model });
      }
    }, request.signal);
  }

  private async generate(model: string, request: CompletionRequest, stream: false): Promise<GeminiGenerateResponse>;
  private async generate(model: string, request: CompletionRequest, stream: true): Promise<Response>;
  private async generate(
    model: string,
    request: CompletionRequest,
    stream: boolean,
  ): Promise<GeminiGenerateResponse | Response> {
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    const url = `${this.baseUrl()}/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(this.config.apiKey)}${stream ? '&alt=sse' : ''}`;
    const body = JSON.stringify(this.createBody(request));
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: request.signal,
    });

    if (!response.ok) {
      throw await createProviderHttpError('google', model, response);
    }

    return stream ? response : ((await response.json()) as GeminiGenerateResponse);
  }

  private createBody(request: CompletionRequest): Record<string, unknown> {
    const { systemInstruction, contents } = this.formatMessages(request.messages);
    const generationConfig: Record<string, unknown> = {
      temperature: request.temperature,
      topP: request.topP,
      topK: request.topK,
      seed: request.seed,
      frequencyPenalty: request.frequencyPenalty,
      presencePenalty: request.presencePenalty,
      maxOutputTokens: request.maxTokens,
      stopSequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
      thinkingConfig: this.thinkingConfig(request),
    };

    if (request.responseFormat?.type === 'json') {
      generationConfig.responseMimeType = 'application/json';
    } else if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = request.responseFormat.schema;
    }

    const tools = this.formatToolsGoogle(request.tools);

    return this.compact({
      contents,
      systemInstruction,
      tools,
      toolConfig: tools ? this.toolConfig(request) : undefined,
      generationConfig: this.compact(generationConfig),
    });
  }

  /**
   * Maps portable reasoning controls onto Gemini's thinking budget.
   *
   * Returns undefined when the request says nothing about reasoning, leaving the model's own
   * default in place rather than forcing a budget on it.
   */
  private thinkingConfig(request: CompletionRequest): Record<string, unknown> | undefined {
    const reasoning = request.reasoning;
    if (!reasoning) return undefined;

    const budget = reasoning.maxTokens ?? (reasoning.effort ? THINKING_BUDGETS[reasoning.effort] : undefined);
    const includeThoughts = reasoning.summary && reasoning.summary !== 'none' ? true : undefined;
    if (budget === undefined && includeThoughts === undefined) return undefined;

    return this.compact({ thinkingBudget: budget, includeThoughts });
  }

  private toolConfig(request: CompletionRequest): Record<string, unknown> | undefined {
    const choice = request.toolChoice;
    if (choice === undefined) return undefined;

    if (typeof choice === 'object') {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
    }

    const mode = choice === 'none' ? 'NONE' : choice === 'required' ? 'ANY' : 'AUTO';
    return { functionCallingConfig: { mode } };
  }

  private formatMessages(messages: Message[]): {
    systemInstruction?: { parts: GeminiContentPart[] };
    contents: GeminiContent[];
  } {
    const systemParts: GeminiContentPart[] = [];
    const contents: GeminiContent[] = [];

    for (const message of messages) {
      const parts = this.formatParts(message.content);

      if (message.role === 'system') {
        systemParts.push(...parts);
        continue;
      }

      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }

    return {
      systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
      contents,
    };
  }

  private formatParts(content: Message['content']): GeminiContentPart[] {
    if (typeof content === 'string') return [{ text: content }];

    return content.map((part: ContentPart) => {
      if (part.type === 'text') return { text: part.text };
      if (part.type === 'image') {
        const source = part.source;
        if ('base64' in source) {
          return { inlineData: { mimeType: source.mimeType || 'image/png', data: source.base64 } };
        }
        if ('buffer' in source) {
          return {
            inlineData: {
              mimeType: source.mimeType || 'image/png',
              data: source.buffer.toString('base64'),
            },
          };
        }
        if ('url' in source) return { text: `[image url: ${source.url}]` };
        return { text: '[image from path requires preprocessing]' };
      }
      if (part.type === 'audio' && 'transcript' in part.source) {
        return { text: part.source.transcript };
      }
      return { text: `[${part.type} content is not yet supported for Google provider]` };
    });
  }

  private formatToolsGoogle(tools?: CompletionRequest['tools']): unknown[] | undefined {
    if (!tools?.length) return undefined;
    return [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }

  /** Reasoning summaries are marked `thought` and are excluded from visible output. */
  private extractText(content: GeminiContent | undefined): string {
    return (content?.parts || [])
      .filter((part) => typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('');
  }

  private extractToolCalls(content: GeminiContent | undefined): ToolCall[] {
    return (content?.parts || [])
      .filter((part) => part.functionCall)
      .map((part) => ({
        id: generateRequestId(),
        type: 'function' as const,
        function: {
          name: part.functionCall?.name || '',
          arguments: JSON.stringify(part.functionCall?.args || {}),
        },
      }))
      .filter((toolCall) => toolCall.function.name);
  }

  private mapFinishReason(reason?: string): NexusResponse['finishReason'] {
    if (reason === 'MAX_TOKENS') return 'length';
    if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter';
    return 'stop';
  }

  private extractModel(model: string): string {
    if (model.startsWith('google/')) return model.slice('google/'.length);
    return model;
  }

  private baseUrl(): string {
    return (this.config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  }

  private compact<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
  }
}
