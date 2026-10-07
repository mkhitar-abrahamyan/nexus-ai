/**
 * AG-UI: a graph's run as the Agent-User Interaction protocol, so any AG-UI frontend renders a Nexus
 * agent with no Nexus client code.
 *
 * A frontend POSTs a `RunAgentInput` — the thread, the whole conversation, any tools and context —
 * and reads Server-Sent Events back:
 * - the run starting and finishing;
 * - each step;
 * - text as it streams;
 * - each tool call with its arguments and result;
 * - the final state.
 *
 * A run that pauses for a person ends with an interrupt outcome naming each question. The frontend
 * answers with a `resume` entry per question, and the run continues where it stopped.
 */
import type { GraphEvent } from '../types/graph.js';
import type { Message } from '../types/messages.js';
import type { Principal } from '../types/principal.js';
import {
  answerOf,
  asText,
  messageOf,
  type ProtocolGraph,
  type ProtocolInterrupt,
  type ProtocolResult,
  type ProtocolRole,
  protocolId,
  textOf,
  toolCallOf,
} from './shared.js';

export type { ProtocolGraph, ProtocolInterrupt, ProtocolResult, ProtocolRunOptions } from './shared.js';

/** A message in AG-UI's shape. */
export interface AgUiMessage {
  /** Its id. */
  id: string;
  /** `user`, `assistant`, `system`, `developer`, or `tool`; other roles are passed over. */
  role: string;
  /** Its text, or a list of parts with text. */
  content?: unknown;
  /** The tool calls an assistant message made. */
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** The call a tool message answers. */
  toolCallId?: string;
}

/** One answer to an interrupt, in a resumed run. */
export interface AgUiResumeEntry {
  /** The interrupt it answers. */
  interruptId: string;
  /** `resolved` with a payload, or `cancelled`. */
  status: 'resolved' | 'cancelled';
  /** The answer. */
  payload?: unknown;
}

/** What a frontend sends to start or resume a run: AG-UI's `RunAgentInput`. */
export interface AgUiRunInput {
  /** The conversation. */
  threadId: string;
  /** This run. */
  runId: string;
  /** The run this one continues, when it does. */
  parentRunId?: string;
  /** The whole conversation so far. */
  messages: AgUiMessage[];
  /** Tools the frontend offers. Passed to `input` for an application that uses them. */
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
  /** Extra context the frontend supplies. */
  context?: Array<{ description: string; value: string }>;
  /** Shared state, when the frontend keeps any. */
  state?: unknown;
  /** Anything else the frontend forwards. */
  forwardedProps?: unknown;
  /** Answers to the questions a paused run asked. */
  resume?: AgUiResumeEntry[];
}

/** A question a paused run asks, in AG-UI's shape. */
export interface AgUiInterrupt {
  /** Its id, which a resume entry names. */
  id: string;
  /** `tool_call` for an approval, `input_required` for anything else. */
  reason: string;
  /** The question, for a person. */
  message?: string;
  /** The tool call awaiting approval, when it is one. */
  toolCallId?: string;
  /** What the run asked about, whole. */
  metadata?: Record<string, unknown>;
}

/** An AG-UI event, as the stream carries it. */
export type AgUiEvent = { type: string; timestamp?: number } & Record<string, unknown>;

/** Options for `agUiEvents()` and `agUiHandler()`. */
export interface AgUiOptions {
  /**
   * The graph input for a run. Defaults to `{ messages }`, the conversation as Nexus messages,
   * which is what an agent from `createAgent()` takes.
   */
  input?: (run: AgUiRunInput, messages: Message[]) => unknown;
  /** The answer a resume entry gives a question. Defaults to its payload, `true` when it has none, and `false` when cancelled. */
  answer?: (entry: AgUiResumeEntry) => unknown;
  /** Who the run is for, from the request: the place to authenticate a frontend's caller. */
  principal?: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
  /** Adds a `STATE_SNAPSHOT` with the final state before the run finishes. Defaults to true. */
  stateSnapshot?: boolean;
}

/** Options for `agUiEvents()`: everything `agUiHandler()` takes, with the caller already known. */
export interface AgUiEventsOptions extends Omit<AgUiOptions, 'principal'> {
  /** Stops the run. */
  signal?: AbortSignal;
  /** Who the run is for. */
  principal?: Principal;
}

/** The conversation from a `RunAgentInput`, as Nexus messages. */
export function agUiMessages(messages: readonly AgUiMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    if (!['user', 'assistant', 'system', 'developer', 'tool'].includes(message.role)) continue;
    const content = textOf(message.content);
    converted.push(
      messageOf(message.role as ProtocolRole, content, {
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
        ...(message.role === 'tool' && message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      }),
    );
  }
  return converted;
}

/**
 * A run as AG-UI events, for any transport: Server-Sent Events, a WebSocket, a test. Events are
 * produced as the graph emits them; the last is `RUN_FINISHED` or `RUN_ERROR`.
 */
export async function* agUiEvents(
  graph: ProtocolGraph,
  run: AgUiRunInput,
  options: AgUiEventsOptions = {},
): AsyncGenerator<AgUiEvent> {
  const queue: AgUiEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const push = (event: AgUiEvent) => {
    queue.push({ ...event, timestamp: Date.now() });
    wake?.();
  };
  const translate = translator(push);

  push({
    type: 'RUN_STARTED',
    threadId: run.threadId,
    runId: run.runId,
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
  });
  const runOptions = {
    threadId: run.threadId,
    onEvent: translate.event,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.principal ? { principal: options.principal } : {}),
  };
  const finished = (async () => {
    try {
      let result: ProtocolResult;
      if (run.resume?.length) {
        const answer =
          options.answer ??
          ((entry: AgUiResumeEntry) => (entry.status === 'cancelled' ? false : (entry.payload ?? true)));
        result = await graph.resumeInterruptsWith(
          run.threadId,
          Object.fromEntries(run.resume.map((entry) => [entry.interruptId, answer(entry)])),
          runOptions,
        );
      } else {
        const messages = agUiMessages(run.messages);
        result = await graph.invoke(options.input ? options.input(run, messages) : { messages }, runOptions);
      }
      translate.close();
      if (options.stateSnapshot !== false) push({ type: 'STATE_SNAPSHOT', snapshot: result.state });
      push(finishedEvent(run, result));
    } catch (error) {
      translate.close();
      push({
        type: 'RUN_ERROR',
        message: error instanceof Error ? error.message : String(error),
        ...((error as { code?: unknown })?.code ? { code: String((error as { code: unknown }).code) } : {}),
      });
    } finally {
      done = true;
      wake?.();
    }
  })();

  while (true) {
    if (queue.length > 0) {
      yield queue.shift() as AgUiEvent;
      continue;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }
  await finished;
}

/**
 * An HTTP handler that serves a graph to AG-UI frontends: POST a `RunAgentInput`, read the run as
 * Server-Sent Events. Mount it on any route, under any framework that speaks `Request` and
 * `Response`.
 *
 * ```ts
 * const handler = agUiHandler(agent);
 * app.post('/agent', (request) => handler(request));
 * ```
 */
export function agUiHandler(graph: ProtocolGraph, options: AgUiOptions = {}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST')
      return new Response('AG-UI runs are POSTed', { status: 405, headers: { allow: 'POST' } });
    let run: AgUiRunInput;
    try {
      run = (await request.json()) as AgUiRunInput;
    } catch {
      return new Response('The body is not a RunAgentInput', { status: 400 });
    }
    if (typeof run?.threadId !== 'string' || (!Array.isArray(run.messages) && !run.resume)) {
      return new Response('A RunAgentInput needs a threadId and messages', { status: 400 });
    }
    run = { ...run, runId: run.runId || protocolId('run'), messages: run.messages ?? [] };
    const caller = await options.principal?.(request);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const { principal: _resolve, ...rest } = options;
        for await (const event of agUiEvents(graph, run, {
          ...rest,
          signal: request.signal,
          ...(caller ? { principal: caller } : {}),
        })) {
          controller.enqueue(encoder.encode(encodeAgUiEvent(event)));
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
    });
  };
}

/** One event as a Server-Sent Event: `data: <json>` and a blank line. */
export function encodeAgUiEvent(event: AgUiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Turns graph events into AG-UI events: text grouped into messages, steps, and tool calls. */
function translator(push: (event: AgUiEvent) => void) {
  let open: string | undefined;
  const closeMessage = () => {
    if (open) push({ type: 'TEXT_MESSAGE_END', messageId: open });
    open = undefined;
  };
  return {
    event(event: GraphEvent) {
      // A subgraph's events belong to its parent's step; only the graph's own steps are reported.
      if (event.type === 'task_start' && !event.namespace) push({ type: 'STEP_STARTED', stepName: event.node });
      else if (event.type === 'task_end' && !event.namespace) {
        closeMessage();
        push({ type: 'STEP_FINISHED', stepName: event.node });
      } else if (event.type === 'message' && event.chunk.kind !== 'reasoning' && event.chunk.content) {
        const messageId = event.chunk.messageId ?? `${event.taskId}:${event.step}`;
        if (open !== messageId) {
          closeMessage();
          open = messageId;
          push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
        }
        push({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: event.chunk.content });
      } else if (event.type === 'tool') {
        closeMessage();
        const tool = event.tool;
        if (tool.phase === 'start') {
          push({ type: 'TOOL_CALL_START', toolCallId: tool.id, toolCallName: tool.name });
          push({ type: 'TOOL_CALL_ARGS', toolCallId: tool.id, delta: asText(tool.args ?? {}) });
          push({ type: 'TOOL_CALL_END', toolCallId: tool.id });
        } else if (tool.phase === 'result' || tool.phase === 'error') {
          push({
            type: 'TOOL_CALL_RESULT',
            messageId: `${tool.id}:result`,
            toolCallId: tool.id,
            role: 'tool',
            content: tool.phase === 'result' ? asText(tool.result) : (tool.error ?? 'The tool failed'),
          });
        }
      }
    },
    close: closeMessage,
  };
}

function finishedEvent(run: AgUiRunInput, result: ProtocolResult): AgUiEvent {
  const base = { type: 'RUN_FINISHED', threadId: run.threadId, runId: run.runId };
  if (result.status === 'awaiting_input' && result.interrupts?.length) {
    return { ...base, outcome: { type: 'interrupt', interrupts: result.interrupts.map(agUiInterrupt) } };
  }
  return { ...base, outcome: { type: 'success' }, result: answerOf(result.state) };
}

function agUiInterrupt(interrupt: ProtocolInterrupt): AgUiInterrupt {
  const call = toolCallOf(interrupt);
  return {
    id: interrupt.id,
    reason: call ? 'tool_call' : 'input_required',
    ...(interrupt.reason ? { message: interrupt.reason } : {}),
    ...(call ? { toolCallId: call.id } : {}),
    ...(interrupt.payload === undefined ? {} : { metadata: { payload: interrupt.payload } }),
  };
}
