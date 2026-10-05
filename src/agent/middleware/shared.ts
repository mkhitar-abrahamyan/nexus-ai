import type { Message } from '../../types/messages.js';
import type { AgentToolCall } from '../create-agent.js';

/**
 * What the middleware share. Every count here is read from the transcript rather than kept in
 * memory, so it survives a restart, a resumed approval, and a second process, and two threads never
 * share one.
 */

/**
 * The current turn: every message after the latest user message. One `invoke()` is one turn; a run
 * that resumes after an approval is the same turn.
 */
export function turnOf(messages: readonly Message[]): readonly Message[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages.slice(index + 1);
  }
  return messages;
}

/** Model calls made in the current turn: its assistant messages. */
export function modelCallsInTurn(messages: readonly Message[]): number {
  return turnOf(messages).filter((message) => message.role === 'assistant').length;
}

/**
 * Where a call sits among the current turn's calls to the same tool, from 1. Calls the model made in
 * parallel are ordered as the model listed them, so the position never depends on which finished
 * first.
 */
export function callPosition(messages: readonly Message[], call: Pick<AgentToolCall, 'id' | 'name'>): number {
  let position = 0;
  for (const message of turnOf(messages)) {
    for (const made of message.toolCalls ?? []) {
      if (made.function.name !== call.name) continue;
      position += 1;
      if (made.id === call.id) return position;
    }
  }
  return position + 1;
}

/** A message's text: the string, or its text parts joined. */
export function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n');
}

/** How long to wait between attempts. */
export interface RetryBackoff {
  /** The wait before the second attempt, in milliseconds. Defaults to 500. */
  initialMs?: number;
  /** The longest wait, in milliseconds. Defaults to 10,000. */
  maxMs?: number;
  /** What each wait is multiplied by. Defaults to 2. */
  factor?: number;
  /** Spreads each wait between half and all of it, so runs that failed together retry apart. Defaults to true. */
  jitter?: boolean;
}

/** The wait before attempt `attempt + 1`, after `attempt` failed. */
export function backoffDelay(attempt: number, backoff: RetryBackoff = {}): number {
  const initial = backoff.initialMs ?? 500;
  const delay = Math.min(backoff.maxMs ?? 10_000, initial * (backoff.factor ?? 2) ** Math.max(0, attempt - 1));
  return backoff.jitter === false ? delay : delay / 2 + Math.random() * (delay / 2);
}

/** Waits, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** True for a cancellation: never worth retrying or falling back from. */
export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === 'AbortError';
}

/** A short, stable hash of a text: cyrb53 as 8 hex digits. Not a security boundary. */
export function shortHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(-8);
}
