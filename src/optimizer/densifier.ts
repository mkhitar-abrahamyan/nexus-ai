import type { CompletionRequest } from '../types/messages.js';
import type { DensificationConfig } from '../types/optimizer.js';

export class PromptDensifier {
  densifyRequest(request: CompletionRequest, config: DensificationConfig = {}): { request: CompletionRequest; techniques: string[] } {
    if (config.enabled === false) return { request, techniques: [] };

    const techniques = config.techniques || ['whitespace-cleanup', 'phrase-compression', 'list-compaction'];
    const applied = new Set<string>();

    const next: CompletionRequest = {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content: typeof message.content === 'string'
          ? this.densifyText(message.content, techniques, applied, config)
          : message.content.map((part) => part.type === 'text'
              ? { ...part, text: this.densifyText(part.text, techniques, applied, config) }
              : part),
      })),
    };

    return { request: next, techniques: [...applied] };
  }

  densifyText(text: string, techniques: string[], applied: Set<string>, config: DensificationConfig): string {
    const segments = this.splitCodeBlocks(text, config.preserveCodeBlocks !== false);

    return segments.map((segment) => {
      if (segment.type === 'code') return segment.value;

      let output = segment.value;

      if (techniques.includes('whitespace-cleanup')) {
        const before = output;
        output = output
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]+\n/g, '\n')
          .trim();
        if (output !== before) applied.add('whitespace-cleanup');
      }

      if (techniques.includes('phrase-compression')) {
        const before = output;
        output = output
          .replace(/please make sure that/gi, 'ensure')
          .replace(/you should/gi, 'do')
          .replace(/it is important to/gi, 'must')
          .replace(/in order to/gi, 'to')
          .replace(/due to the fact that/gi, 'because')
          .replace(/at this point in time/gi, 'now')
          .replace(/as soon as possible/gi, 'ASAP');
        if (output !== before) applied.add('phrase-compression');
      }

      if (techniques.includes('list-compaction')) {
        const before = output;
        output = output.replace(/\n\s*[-*]\s+/g, '\n- ');
        if (output !== before) applied.add('list-compaction');
      }

      return output;
    }).join('');
  }

  private splitCodeBlocks(text: string, preserveCodeBlocks: boolean): Array<{ type: 'text' | 'code'; value: string }> {
    if (!preserveCodeBlocks) return [{ type: 'text', value: text }];

    const parts: Array<{ type: 'text' | 'code'; value: string }> = [];
    const regex = /```[\s\S]*?```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      parts.push({ type: 'code', value: match[0] });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      parts.push({ type: 'text', value: text.slice(lastIndex) });
    }

    return parts;
  }
}
