import type { CompletionRequest, Message } from '../types/messages.js';

export class Tokenizer {
  estimateTextTokens(text: string): number {
    if (!text) return 0;

    const normalized = text.trim();
    if (!normalized) return 0;

    const wordLike = normalized.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
    const charEstimate = Math.ceil(normalized.length / 4);

    return Math.max(1, Math.ceil((wordLike.length + charEstimate) / 2));
  }

  estimateMessageTokens(message: Message): number {
    const roleOverhead = 4;

    if (typeof message.content === 'string') {
      return roleOverhead + this.estimateTextTokens(message.content);
    }

    return (
      roleOverhead +
      message.content.reduce((total, part) => {
        if (part.type === 'text') return total + this.estimateTextTokens(part.text);
        if (part.type === 'image') return total + 85;
        if (part.type === 'audio') return total + 120;
        if (part.type === 'video') return total + 250;
        return total;
      }, 0)
    );
  }

  estimateRequestTokens(request: CompletionRequest): number {
    const modelOverhead = 8;
    const toolOverhead =
      request.tools?.reduce((total, tool) => {
        return total + this.estimateTextTokens(tool.name) + this.estimateTextTokens(tool.description) + 20;
      }, 0) || 0;

    return (
      modelOverhead +
      toolOverhead +
      request.messages.reduce((total, message) => {
        return total + this.estimateMessageTokens(message);
      }, 0)
    );
  }
}
