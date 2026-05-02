import type { CompletionRequest, Message } from '../types/messages.js';
import type { InjectionDetectionConfig, SecurityFinding } from '../types/security.js';

const DEFAULT_PATTERNS: Array<{ pattern: RegExp; severity: SecurityFinding['severity']; label: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 'critical', label: 'ignore previous instructions' },
  { pattern: /disregard\s+(all\s+)?(prior|previous)\s+instructions/i, severity: 'critical', label: 'disregard previous instructions' },
  { pattern: /you\s+are\s+now\s+(dan|developer\s+mode|jailbreak)/i, severity: 'critical', label: 'role jailbreak' },
  { pattern: /reveal\s+(your\s+)?(system|developer)\s+prompt/i, severity: 'high', label: 'prompt exfiltration' },
  { pattern: /print\s+(your\s+)?(hidden|internal)\s+instructions/i, severity: 'high', label: 'instruction exfiltration' },
  { pattern: /act\s+as\s+if\s+you\s+have\s+no\s+(rules|restrictions|limitations)/i, severity: 'high', label: 'restriction bypass' },
  { pattern: /BEGIN\s+(SYSTEM|DEVELOPER|INSTRUCTIONS)/i, severity: 'medium', label: 'instruction block injection' },
  { pattern: /<\/?system>|<\/?developer>|<\/?instructions>/i, severity: 'medium', label: 'synthetic role tag' },
];

export class InjectionDetector {
  detect(request: CompletionRequest, config: InjectionDetectionConfig = {}): SecurityFinding[] {
    if (config.enabled === false) return [];

    const patterns = [
      ...DEFAULT_PATTERNS,
      ...(config.customPatterns || []).map((pattern) => ({
        pattern,
        severity: 'high' as const,
        label: 'custom pattern',
      })),
    ];

    const findings: SecurityFinding[] = [];

    request.messages.forEach((message, index) => {
      for (const text of this.extractText(message)) {
        patterns.forEach(({ pattern, severity, label }) => {
          const match = text.match(pattern);
          if (!match) return;

          findings.push({
            type: 'prompt-injection',
            severity,
            message: `Potential prompt injection detected: ${label}`,
            path: `messages.${index}.content`,
            value: match[0],
          });
        });
      }
    });

    return findings;
  }

  neutralize(request: CompletionRequest): CompletionRequest {
    return {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content: typeof message.content === 'string'
          ? this.escapeInstructionLikeText(message.content)
          : message.content.map((part) => part.type === 'text'
              ? { ...part, text: this.escapeInstructionLikeText(part.text) }
              : part),
      })),
    };
  }

  private extractText(message: Message): string[] {
    if (typeof message.content === 'string') return [message.content];
    return message.content.filter((part) => part.type === 'text').map((part) => part.text);
  }

  private escapeInstructionLikeText(text: string): string {
    return text
      .replace(/ignore\s+(all\s+)?previous\s+instructions/gi, '[neutralized instruction override]')
      .replace(/disregard\s+(all\s+)?(prior|previous)\s+instructions/gi, '[neutralized instruction override]')
      .replace(/reveal\s+(your\s+)?(system|developer)\s+prompt/gi, '[neutralized prompt exfiltration request]');
  }
}
