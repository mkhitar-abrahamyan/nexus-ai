import type { CompletionRequest } from '../types/messages.js';
import type { DensificationConfig } from '../types/optimizer.js';

/** Wordy phrases and their shorter equivalents, matched as whole words in any case. */
const PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bplease make sure that\b/gi, 'ensure'],
  [/\byou should\b/gi, 'do'],
  [/\bit is important to\b/gi, 'must'],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bas soon as possible\b/gi, 'ASAP'],
];

/** Rewrites prompts to use fewer tokens without changing what they say. */
export class PromptDensifier {
  /** Densifies every text message in a request. */
  densifyRequest(
    request: CompletionRequest,
    config: DensificationConfig = {},
  ): { request: CompletionRequest; techniques: string[] } {
    if (config.enabled === false) return { request, techniques: [] };

    const techniques = config.techniques || ['whitespace-cleanup', 'phrase-compression', 'list-compaction'];
    const applied = new Set<string>();

    const next: CompletionRequest = {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content:
          typeof message.content === 'string'
            ? this.densifyText(message.content, techniques, applied, config)
            : message.content.map((part) =>
                part.type === 'text'
                  ? { ...part, text: this.densifyText(part.text, techniques, applied, config) }
                  : part,
              ),
      })),
    };

    return { request: next, techniques: [...applied] };
  }

  /**
   * Densifies one text, leaving fenced code untouched unless configured otherwise, and records the
   * techniques applied.
   */
  densifyText(text: string, techniques: string[], applied: Set<string>, config: DensificationConfig): string {
    const segments = this.splitCodeBlocks(text, config.preserveCodeBlocks !== false);

    const joined = segments
      .map((segment) => {
        if (segment.type === 'code') return segment.value;

        let output = segment.value;

        if (techniques.includes('whitespace-cleanup')) {
          const before = output;
          // Not trimmed here: the line breaks around a code block keep its fences on lines of their own.
          output = output
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]+\n/g, '\n');
          if (output !== before) applied.add('whitespace-cleanup');
        }

        if (techniques.includes('phrase-compression')) {
          const before = output;
          for (const [phrase, shorter] of PHRASES) {
            // Whole words only, so "in order today" keeps its "today"; a capital stays a capital.
            output = output.replace(phrase, (match) =>
              /^[A-Z]/.test(match) ? `${shorter.charAt(0).toUpperCase()}${shorter.slice(1)}` : shorter,
            );
          }
          if (output !== before) applied.add('phrase-compression');
        }

        if (techniques.includes('list-compaction')) {
          const before = output;
          output = output.replace(/\n\s*[-*]\s+/g, '\n- ');
          if (output !== before) applied.add('list-compaction');
        }

        return output;
      })
      .join('');
    if (!techniques.includes('whitespace-cleanup')) return joined;
    const trimmed = joined.trim();
    if (trimmed !== joined) applied.add('whitespace-cleanup');
    return trimmed;
  }

  private splitCodeBlocks(text: string, preserveCodeBlocks: boolean): Array<{ type: 'text' | 'code'; value: string }> {
    if (!preserveCodeBlocks) return [{ type: 'text', value: text }];

    const parts: Array<{ type: 'text' | 'code'; value: string }> = [];
    const regex = /```[\s\S]*?```/g;
    let lastIndex = 0;
    let match = regex.exec(text);
    while (match !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      parts.push({ type: 'code', value: match[0] });
      lastIndex = match.index + match[0].length;
      match = regex.exec(text);
    }

    if (lastIndex < text.length) {
      parts.push({ type: 'text', value: text.slice(lastIndex) });
    }

    return parts;
  }
}
