import type { CompletionRequest } from '../types/messages.js';
import type { BudgetConfig } from '../types/optimizer.js';
import { Tokenizer } from '../utils/tokenizer.js';

export class TokenBudgetError extends Error {
  constructor(
    public tokens: number,
    public maxTokens: number,
  ) {
    super(`Token budget exceeded: ${tokens} tokens > ${maxTokens} max tokens`);
    this.name = 'TokenBudgetError';
  }
}

export class BudgetEnforcer {
  constructor(private tokenizer = new Tokenizer()) {}

  check(
    request: CompletionRequest,
    config: BudgetConfig = {},
  ): { warnings: string[]; exceeded: boolean; tokens: number } {
    if (config.enabled === false || !config.maxInputTokens) {
      return { warnings: [], exceeded: false, tokens: this.tokenizer.estimateRequestTokens(request) };
    }

    const tokens = this.tokenizer.estimateRequestTokens(request);
    const warnings: string[] = [];
    const warnAt = config.warnAt ?? 0.8;

    if (tokens >= config.maxInputTokens * warnAt) {
      warnings.push(`Token usage is at ${Math.round((tokens / config.maxInputTokens) * 100)}% of budget`);
    }

    return {
      warnings,
      exceeded: tokens > config.maxInputTokens,
      tokens,
    };
  }

  enforce(request: CompletionRequest, config: BudgetConfig = {}): CompletionRequest {
    if (config.enabled === false || !config.maxInputTokens) return request;

    const status = this.check(request, config);
    if (!status.exceeded) return request;

    const action = config.onExceeded || 'error';

    if (action === 'allow' || action === 'densify') return request;
    if (action === 'error') throw new TokenBudgetError(status.tokens, config.maxInputTokens);
    if (action === 'truncate') return this.truncateToBudget(request, config.maxInputTokens);

    return request;
  }

  private truncateToBudget(request: CompletionRequest, maxTokens: number): CompletionRequest {
    const next: CompletionRequest = {
      ...request,
      messages: [...request.messages],
    };

    while (this.tokenizer.estimateRequestTokens(next) > maxTokens && next.messages.length > 0) {
      const firstUserIndex = next.messages.findIndex((message) => message.role !== 'system');
      const indexToTrim = firstUserIndex >= 0 ? firstUserIndex : 0;
      const message = next.messages[indexToTrim];

      if (typeof message.content === 'string') {
        if (message.content.length < 200) {
          next.messages.splice(indexToTrim, 1);
        } else {
          next.messages[indexToTrim] = {
            ...message,
            content: message.content.slice(Math.floor(message.content.length * 0.25)),
          };
        }
      } else {
        const textPartIndex = message.content.findIndex((part) => part.type === 'text');
        if (textPartIndex < 0) {
          next.messages.splice(indexToTrim, 1);
        } else {
          const part = message.content[textPartIndex];
          if (part.type === 'text') {
            const content = [...message.content];
            content[textPartIndex] = {
              ...part,
              text: part.text.length < 200 ? '' : part.text.slice(Math.floor(part.text.length * 0.25)),
            };
            next.messages[indexToTrim] = { ...message, content };
          }
        }
      }
    }

    return next;
  }
}
