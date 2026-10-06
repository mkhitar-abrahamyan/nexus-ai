import type { CompletionRequest, Message } from '../types/messages.js';
import type { PIIConfig, PIIType, SecurityFinding } from '../types/security.js';
import { luhn, phoneNumber } from '../utils/checksums.js';

/**
 * Checks a match must pass to count. Without them any long run of digits — an order id, a millisecond
 * timestamp — reads as a card or a phone number, and masking it corrupts the data the model needed.
 */
const VALIDATORS: Partial<Record<PIIType, (value: string) => boolean>> = {
  'credit-card': luhn,
  phone: phoneNumber,
};
const isValid = (type: PIIType, value: string): boolean => VALIDATORS[type]?.(value) ?? true;

/**
 * The order kinds claim text in: the most specific first, so the digits of a card number are never
 * also read as a phone number, and masking a card never leaves part of it showing.
 */
const PRIORITY: readonly PIIType[] = ['private-key', 'aws-key', 'credit-card', 'email', 'ip-address', 'phone'];
const DEFAULT_TYPES: PIIType[] = ['email', 'phone', 'credit-card', 'ip-address', 'aws-key', 'private-key'];
const ordered = (types: readonly PIIType[]): PIIType[] => PRIORITY.filter((type) => types.includes(type));

const PII_PATTERNS: Record<PIIType, RegExp> = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g,
  'credit-card': /\b(?:\d[ -]*?){13,19}\b/g,
  'ip-address': /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  'aws-key': /\bAKIA[0-9A-Z]{16}\b/g,
  'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
};

/** Finds and masks personal data such as emails, phone numbers, and card numbers. */
export class PIIDetector {
  /** Finds personal data in a request's messages. */
  detect(request: CompletionRequest, config: PIIConfig = {}): SecurityFinding[] {
    if (config.enabled === false) return [];

    const enabledTypes = ordered(config.detect || DEFAULT_TYPES);
    const findings: SecurityFinding[] = [];

    request.messages.forEach((message, index) => {
      for (const text of this.extractText(message)) {
        // Text one kind has claimed is not claimed again by a less specific one.
        const claimed: Array<[number, number]> = [];
        for (const type of enabledTypes) {
          for (const match of text.matchAll(new RegExp(PII_PATTERNS[type]))) {
            const value = match[0];
            const start = match.index ?? 0;
            const end = start + value.length;
            if (!isValid(type, value) || claimed.some(([from, to]) => start < to && end > from)) continue;
            claimed.push([start, end]);
            findings.push({
              type: 'pii',
              severity: type === 'private-key' || type === 'aws-key' ? 'critical' : 'high',
              message: `Detected ${type}`,
              path: `messages.${index}.content`,
              value,
              metadata: { piiType: type },
            });
          }
        }
      }
    });

    return findings;
  }

  /** Returns the request with personal data masked, or removed when the action is `remove`. */
  mask(request: CompletionRequest, config: PIIConfig = {}): CompletionRequest {
    const enabledTypes = ordered(config.detect || DEFAULT_TYPES);
    const maskChar = config.maskChar || '█';
    const remove = config.action === 'remove';

    return {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content:
          typeof message.content === 'string'
            ? this.maskText(message.content, enabledTypes, maskChar, config.preserveFormat !== false, remove)
            : message.content.map((part) =>
                part.type === 'text'
                  ? {
                      ...part,
                      text: this.maskText(part.text, enabledTypes, maskChar, config.preserveFormat !== false, remove),
                    }
                  : part,
              ),
      })),
    };
  }

  private maskText(text: string, types: PIIType[], maskChar: string, preserveFormat: boolean, remove = false): string {
    let masked = text;

    for (const type of types) {
      masked = masked.replace(PII_PATTERNS[type], (value) => {
        if (!isValid(type, value)) return value;
        if (remove) return '';
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
