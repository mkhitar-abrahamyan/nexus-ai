import type { CompletionRequest, Message } from '../types/messages.js';
import type { PIIConfig, PIIType, SecurityFinding } from '../types/security.js';

const PII_PATTERNS: Record<PIIType, RegExp> = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g,
  'credit-card': /\b(?:\d[ -]*?){13,19}\b/g,
  'ip-address': /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  'aws-key': /\bAKIA[0-9A-Z]{16}\b/g,
  'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
};

export class PIIDetector {
  detect(request: CompletionRequest, config: PIIConfig = {}): SecurityFinding[] {
    if (config.enabled === false) return [];

    const enabledTypes = config.detect || ['email', 'phone', 'credit-card', 'ip-address', 'aws-key', 'private-key'];
    const findings: SecurityFinding[] = [];

    request.messages.forEach((message, index) => {
      for (const text of this.extractText(message)) {
        for (const type of enabledTypes) {
          const pattern = new RegExp(PII_PATTERNS[type]);
          const matches = text.match(pattern) || [];

          matches.forEach((value) => {
            findings.push({
              type: 'pii',
              severity: type === 'private-key' || type === 'aws-key' ? 'critical' : 'high',
              message: `Detected ${type}`,
              path: `messages.${index}.content`,
              value,
              metadata: { piiType: type },
            });
          });
        }
      }
    });

    return findings;
  }

  mask(request: CompletionRequest, config: PIIConfig = {}): CompletionRequest {
    const enabledTypes = config.detect || ['email', 'phone', 'credit-card', 'ip-address', 'aws-key', 'private-key'];
    const maskChar = config.maskChar || '█';

    return {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content: typeof message.content === 'string'
          ? this.maskText(message.content, enabledTypes, maskChar, config.preserveFormat !== false)
          : message.content.map((part) => part.type === 'text'
              ? { ...part, text: this.maskText(part.text, enabledTypes, maskChar, config.preserveFormat !== false) }
              : part),
      })),
    };
  }

  private maskText(text: string, types: PIIType[], maskChar: string, preserveFormat: boolean): string {
    let masked = text;

    for (const type of types) {
      masked = masked.replace(PII_PATTERNS[type], (value) => {
        if (!preserveFormat) return maskChar.repeat(Math.min(value.length, 12));
        return value.replace(/[A-Za-z0-9]/g, maskChar);
      });
    }

    return masked;
  }

  private extractText(message: Message): string[] {
    if (typeof message.content === 'string') return [message.content];
    return message.content.filter((part) => part.type === 'text').map((part) => part.text);
  }
}
