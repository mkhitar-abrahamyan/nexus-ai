import type { ContentPart, Message, ToolOutput } from '../../types/messages.js';
import type { AgentMiddleware, AgentToolResult } from '../create-agent.js';
import { ibanChecksum, luhn, phoneNumber } from '../../utils/checksums.js';
import { shortHash } from './shared.js';

/** The personal data and secrets `piiMiddleware()` finds on its own. */
export type PiiKind = 'email' | 'credit-card' | 'ssn' | 'phone' | 'iban' | 'ip-address' | 'secret';

/**
 * What happens to a match: `redact` replaces it with its kind, `mask` keeps its last four
 * characters, `hash` replaces it with a stable token so two values stay distinguishable, and `block`
 * refuses the whole message.
 */
export type PiiStrategy = 'redact' | 'mask' | 'hash' | 'block';

/** Where a match was found. */
export type PiiWhere = 'input' | 'output' | 'tool';

/** One match, as `onDetect` sees it: never the value itself. */
export interface PiiFinding {
  /** Its kind: a built-in kind or a name from `patterns`. */
  kind: string;
  /** Where it was found. */
  where: PiiWhere;
  /** What was done with it. */
  strategy: PiiStrategy;
}

/** Options for `piiMiddleware()`. */
export interface PiiMiddlewareOptions {
  /** The built-in kinds to find. Defaults to all of them. */
  kinds?: readonly PiiKind[];
  /** Kinds of your own, by name: `{ 'employee-id': /\bEMP-\d{6}\b/ }`. */
  patterns?: Readonly<Record<string, RegExp>>;
  /**
   * What happens to a match, for every kind or per kind: `'mask'`, or
   * `{ email: 'hash', 'credit-card': 'block' }`. Kinds not named are redacted.
   */
  strategy?: PiiStrategy | Readonly<Record<string, PiiStrategy>>;
  /**
   * Where to look. `input` is every message sent to the model but the system prompt; `output` is
   * the model's answer; `toolResults` cleans a result before it enters the transcript, so it is never
   * checkpointed either. Defaults to input and tool results.
   */
  apply?: { input?: boolean; output?: boolean; toolResults?: boolean };
  /** Called for each match, for an audit trail. */
  onDetect?: (finding: PiiFinding) => void;
}

/** Thrown when a match under the `block` strategy is found in the model's input or output. */
export class PiiBlockedError extends Error {
  /** Always `PII_BLOCKED`. */
  readonly code = 'PII_BLOCKED';

  constructor(
    /** The kind that was found. */
    readonly kind: string,
    /** Where it was found. */
    readonly where: PiiWhere,
  ) {
    super(`The ${where === 'input' ? 'request' : 'response'} contains ${kind}, which is blocked`);
    this.name = 'PiiBlockedError';
  }
}

interface Detector {
  pattern: RegExp;
  valid?: (match: string) => boolean;
}

// Ordered so a card number is claimed before the phone pattern could see it.
const DETECTORS: Record<PiiKind, Detector> = {
  secret: {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
  },
  email: { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  'credit-card': { pattern: /\b\d(?:[ -]?\d){12,18}\b/g, valid: luhn },
  iban: { pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, valid: ibanChecksum },
  ssn: { pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  'ip-address': { pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  phone: {
    pattern: /(?<![\w+])\+?(?:\(\d{1,4}\)|\d{1,4})(?:[ .-]?(?:\(\d{1,4}\)|\d{2,4})){2,4}(?!\w)/g,
    valid: phoneNumber,
  },
};
const ORDER: readonly PiiKind[] = ['secret', 'email', 'credit-card', 'iban', 'ssn', 'ip-address', 'phone'];

/**
 * Keeps personal data and secrets away from the model, the transcript, or both.
 *
 * Finds emails, card numbers (checked with Luhn), US social security numbers, phone numbers, IBANs
 * (checked with their checksum), IP addresses, and common API keys and private keys, plus any kinds
 * of your own; and redacts, masks, hashes, or blocks each. The validated kinds keep false positives
 * low: an order number is not a card number unless its checksum says so.
 */
export function piiMiddleware(options: PiiMiddlewareOptions = {}): AgentMiddleware {
  const kinds = new Set(options.kinds ?? ORDER);
  // Compiled once; replace() with a global pattern always starts from the beginning.
  const detectors: Array<[string, Detector]> = [
    ...ORDER.filter((kind) => kinds.has(kind)).map((kind): [string, Detector] => [kind, DETECTORS[kind]]),
    ...Object.entries(options.patterns ?? {}).map(([kind, pattern]): [string, Detector] => [
      kind,
      { pattern: pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`) },
    ]),
  ];
  const apply = { input: true, output: false, toolResults: true, ...options.apply };
  const strategyOf = (kind: string): PiiStrategy =>
    typeof options.strategy === 'string' ? options.strategy : (options.strategy?.[kind] ?? 'redact');

  /** Cleans a text, or returns the kind that blocks it. */
  const clean = (text: string, where: PiiWhere): { text: string } | { blocked: string } => {
    let current = text;
    for (const [kind, detector] of detectors) {
      const strategy = strategyOf(kind);
      let blocked = false;
      current = current.replace(detector.pattern, (match) => {
        if (detector.valid && !detector.valid(match)) return match;
        options.onDetect?.({ kind, where, strategy });
        if (strategy === 'block') blocked = true;
        return replace(match, kind, strategy);
      });
      if (blocked) return { blocked: kind };
    }
    return { text: current };
  };

  const cleanMessage = (message: Message, where: PiiWhere): Message => {
    if (typeof message.content === 'string') {
      const result = clean(message.content, where);
      if ('blocked' in result) throw new PiiBlockedError(result.blocked, where);
      return result.text === message.content ? message : { ...message, content: result.text };
    }
    let changed = false;
    const content = message.content.map((part): ContentPart => {
      if (part.type !== 'text') return part;
      const result = clean(part.text, where);
      if ('blocked' in result) throw new PiiBlockedError(result.blocked, where);
      if (result.text === part.text) return part;
      changed = true;
      return { ...part, text: result.text };
    });
    return changed ? { ...message, content } : message;
  };

  return {
    name: 'pii',
    beforeModel({ request }) {
      if (!apply.input) return;
      return {
        ...request,
        messages: request.messages.map((message) =>
          message.role === 'system' ? message : cleanMessage(message, 'input'),
        ),
      };
    },
    afterModel({ response }) {
      if (!apply.output || !response.content) return;
      const result = clean(response.content, 'output');
      if ('blocked' in result) throw new PiiBlockedError(result.blocked, 'output');
      return result.text === response.content ? undefined : { ...response, content: result.text };
    },
    async wrapToolCall(_call, next) {
      const result = await next();
      if (!apply.toolResults || !result.ok) return result;
      let blocked: string | undefined;
      const walk = (value: unknown): unknown => {
        if (blocked) return value;
        if (typeof value === 'string') {
          const cleaned = clean(value, 'tool');
          if ('blocked' in cleaned) {
            blocked = cleaned.blocked;
            return value;
          }
          return cleaned.text;
        }
        if (Array.isArray(value)) return value.map(walk);
        if (isToolOutput(value)) {
          // Only text is searched: an image's bytes are not text, and a match in base64 would be noise.
          const content = value.content.map((part) =>
            part.type === 'text' ? { ...part, text: walk(part.text) as string } : part,
          );
          return { ...value, content };
        }
        if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
          return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
        }
        return value;
      };
      const cleaned = walk(result.result);
      if (blocked)
        return { ok: false, error: `The tool's result was withheld: it contains ${blocked}` } satisfies AgentToolResult;
      return { ...result, result: cleaned };
    },
  };
}

function replace(match: string, kind: string, strategy: PiiStrategy): string {
  if (strategy === 'mask') {
    const visible = match.replace(/[^A-Za-z0-9]/g, '').slice(-4);
    return `${'*'.repeat(Math.max(4, match.length - visible.length))}${visible}`;
  }
  if (strategy === 'hash') return `[${kind}:${shortHash(match)}]`;
  return `[${kind}]`;
}

function isToolOutput(value: unknown): value is ToolOutput {
  return (value as { type?: unknown } | null)?.type === 'tool_output' && Array.isArray((value as ToolOutput).content);
}
