/**
 * What the protocol adapters share: the part of a compiled graph they drive, and the conversions
 * between a protocol's messages and the graph's. Structural, so a protocol entry point never imports
 * the graph runtime: an agent or any compiled graph already satisfies it.
 */
import type { GraphEvent } from '../types/graph.js';
import type { Message } from '../types/messages.js';
import type { Principal } from '../types/principal.js';

/** Run options a protocol passes to a graph. */
export interface ProtocolRunOptions {
  /** The thread: a protocol's conversation, context, or session id. */
  threadId?: string;
  /** Stops the run, as a protocol's cancel does. */
  signal?: AbortSignal;
  /** Receives the run's fine-grained events, which the protocol translates as they happen. */
  onEvent?: (event: GraphEvent) => void;
  /** Who the run is for, when the protocol's transport authenticated the caller. */
  principal?: Principal;
}

/** A question a paused run is waiting on. */
export interface ProtocolInterrupt {
  /** Its id, which an answer names. */
  id: string;
  /** The question. */
  reason?: string;
  /** What it is about, such as the tool call awaiting approval. */
  payload?: unknown;
}

/** What a run ended with. */
export interface ProtocolResult {
  /** The thread it ran on. */
  threadId: string;
  /** `completed`, `awaiting_input`, or another graph status. */
  status: string;
  /** The state it ended with. */
  state: unknown;
  /** Every question a paused run asked. */
  interrupts?: ProtocolInterrupt[];
}

/** The part of a compiled graph the protocols drive. An agent from `createAgent()` satisfies it. */
export interface ProtocolGraph {
  /** Runs an input. */
  invoke(input: unknown, options?: ProtocolRunOptions): Promise<ProtocolResult>;
  /** Answers a paused run's questions, by interrupt id, and continues it. */
  resumeInterruptsWith(
    threadId: string,
    answers: Record<string, unknown>,
    options?: ProtocolRunOptions,
  ): Promise<ProtocolResult>;
}

/** A role a protocol message may carry. */
export type ProtocolRole = 'user' | 'assistant' | 'system' | 'developer' | 'tool' | 'agent';

/** The final answer a run produced: an agent's `answer`, or its state as JSON. */
export function answerOf(state: unknown): string {
  const answer = (state as { answer?: unknown } | null)?.answer;
  if (typeof answer === 'string') return answer;
  return state === undefined ? '' : JSON.stringify(state);
}

/**
 * The conversation a finished run leaves, to send whole with the next turn: an agent's transcript,
 * tool calls and results included, or the fallback for a graph that keeps none.
 */
export function transcriptOf(state: unknown, fallback: Message[]): Message[] {
  const messages = (state as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) && messages.every((item) => typeof (item as Message)?.role === 'string')
    ? (messages as Message[])
    : fallback;
}

/** The text of a protocol message's content, for content as a string or a list of text parts. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const value = part as { text?: unknown; type?: unknown };
        return typeof value.text === 'string' ? value.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** A Nexus message from a protocol role and text. A developer message is a system message. */
export function messageOf(role: ProtocolRole, content: string, extra: Partial<Message> = {}): Message {
  const mapped = role === 'developer' ? 'system' : role === 'agent' ? 'assistant' : role;
  return { role: mapped, content, ...extra };
}

/** A short random id, for runs and messages the protocol creates. */
export function protocolId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

/** Whether an interrupt asks to approve a tool call, as an agent's approvals do. */
export function toolCallOf(interrupt: ProtocolInterrupt): { id: string; name: string; args: unknown } | undefined {
  const payload = interrupt.payload as { id?: unknown; name?: unknown; args?: unknown } | undefined;
  return typeof payload?.id === 'string' && typeof payload.name === 'string'
    ? { id: payload.id, name: payload.name, args: payload.args }
    : undefined;
}

/**
 * Words answering an approval, as an approval: yes, ok, allow, approve, or confirm allows, and
 * anything else refuses, with the words as the reason. A protocol that carries only text needs this
 * so that "no" never reads as consent.
 */
export function approvalOf(text: string): { approved: true } | { approved: false; reason?: string } {
  const words = text.trim();
  if (/^(y|yes|ok|okay|allow|allowed|approve|approved|confirm|confirmed|go ahead)\b/i.test(words)) {
    return { approved: true };
  }
  return { approved: false, ...(words ? { reason: words } : {}) };
}

/** A value as the text a protocol's text field carries. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
