import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, ContentPart, Message } from '../types/messages.js';
import type { GoogleProviderConfig } from '../types/config.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import { generateRequestId } from '../utils/ids.js';
import { KNOWN_MODELS } from '../types/providers.js';

interface GeminiContentPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiContentPart[];
}

export class GoogleProvider extends BaseProvider {
  readonly info: ProviderInfo = { name: 'google', isLocal: false };
  private config: GoogleProviderConfig;

  constructor(config: GoogleProviderConfig) {
    super();
    this.config = config;
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const startTime = Date.now();
    const model = this.extractModel(request.model);
    const result = await this.generate(model, request, false);
    const latency = Date.now() - startTime;
    const candidate = result.candidates?.[0];
    const content = this.extractText(candidate?.content);
    const toolCalls = this.extractToolCalls(candidate?.content);
    const usage = result.usageMetadata || {};
    const inputTokens = usage.promptTokenCount || 0;
    const outputTokens = usage.candidatesTokenCount || 0;
    const caps = KNOWN_MODELS[model];

    return {
      content,
      role: 'assistant',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: toolCalls.length ? 'tool_calls' : this.mapFinishReason(candidate?.finishReason),
      meta: {
        requestId: generateRequestId(),
        providerUsed: 'google',
        modelUsed: model,
        latencyMs: latency,
        tokensInput: inputTokens,
        tokensOutput: outputTokens,
        tokensSaved: 0,
        estimatedCost: caps
          ? `$${(inputTokens / 1000 * caps.costPer1kInput + outputTokens / 1000 * caps.costPer1kOutput).toFixed(4)}`
          : '$0.00',
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }

  stream(request: CompletionRequest): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      const startTime = Date.now();
      const model = self.extractModel(request.model);
      const response = await self.generate(model, request, true);
      const reader = response.body?.getReader();

      if (!reader) {
        yield { type: 'error', error: 'Google stream response did not include a readable body' } satisfies StreamChunk;
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

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

          const parsed = JSON.parse(data);
          const text = self.extractText(parsed.candidates?.[0]?.content);
          if (text) yield { type: 'text', content: text } satisfies StreamChunk;
        }
      }

      yield {
        type: 'done',
        meta: {
          requestId: generateRequestId(),
          providerUsed: 'google',
          modelUsed: model,
          latencyMs: Date.now() - startTime,
          tokensInput: 0,
          tokensOutput: 0,
          tokensSaved: 0,
          estimatedCost: '$0.00',
          cacheHit: false,
          guardrailsApplied: [],
        },
      } satisfies StreamChunk;
    });
  }

  private async generate(model: string, request: CompletionRequest, stream: false): Promise<any>;
  private async generate(model: string, request: CompletionRequest, stream: true): Promise<Response>;
  private async generate(model: string, request: CompletionRequest, stream: boolean): Promise<any | Response> {
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    const url = `${this.baseUrl()}/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(this.config.apiKey)}${stream ? '&alt=sse' : ''}`;
    const body = JSON.stringify(this.createBody(request));
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    if (!response.ok) {
      throw new Error(`Google Gemini request failed: ${response.status} ${await response.text()}`);
    }

    return stream ? response : response.json();
  }

  private createBody(request: CompletionRequest): Record<string, unknown> {
    const { systemInstruction, contents } = this.formatMessages(request.messages);
    const generationConfig: Record<string, unknown> = {
      temperature: request.temperature,
      topP: request.topP,
      maxOutputTokens: request.maxTokens,
      stopSequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
    };

    if (request.responseFormat?.type === 'json') {
      generationConfig.responseMimeType = 'application/json';
    } else if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = request.responseFormat.schema;
    }

    return {
      contents,
      systemInstruction,
      tools: this.formatToolsGoogle(request.tools),
      generationConfig: this.compact(generationConfig),
    };
  }

  private formatMessages(messages: Message[]): { systemInstruction?: { parts: GeminiContentPart[] }; contents: GeminiContent[] } {
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
    return [{
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }];
  }

  private extractText(content: any): string {
    return (content?.parts || [])
      .filter((part: any) => typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('');
  }

  private extractToolCalls(content: any): ToolCall[] {
    return (content?.parts || [])
      .filter((part: any) => part.functionCall)
      .map((part: any) => ({
        id: generateRequestId(),
        type: 'function' as const,
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      }));
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
