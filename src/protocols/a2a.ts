/**
 * A2A, the Agent2Agent protocol (version 1.0): a Nexus agent served to remote agents, and remote
 * agents called from a Nexus agent.
 *
 * The server publishes an agent card at `/.well-known/agent-card.json` and answers JSON-RPC 2.0 over
 * HTTP:
 * - `SendMessage`, and `SendStreamingMessage` with its events;
 * - `GetTask` and `CancelTask`.
 *
 * A task that pauses for an answer is `TASK_STATE_INPUT_REQUIRED`, and a message naming the task
 * resumes it. The client and `a2aTool()` speak the same protocol to any A2A agent. A remote agent is
 * then one more tool, which declares the host it reaches, so a permission policy decides it.
 */
import type { GraphEvent } from '../types/graph.js';
import type { Message, ToolDefinition } from '../types/messages.js';
import type { Principal } from '../types/principal.js';
import {
  answerOf,
  approvalOf,
  messageOf,
  type ProtocolGraph,
  type ProtocolInterrupt,
  type ProtocolResult,
  type ProtocolRunOptions,
  protocolId,
  toolCallOf,
  transcriptOf,
} from './shared.js';

export type { ProtocolGraph, ProtocolInterrupt, ProtocolResult, ProtocolRunOptions } from './shared.js';

/** The protocol version this module speaks. */
export const A2A_PROTOCOL_VERSION = '1.0';

/** Who a message is from. */
export type A2aRole = 'ROLE_USER' | 'ROLE_AGENT';

/** Where a task stands. */
export type A2aTaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

/** One part of a message or an artifact: text, structured data, or a file by URL or bytes. */
export interface A2aPart {
  /** Text. */
  text?: string;
  /** Structured data. */
  data?: unknown;
  /** A file, by URL. */
  url?: string;
  /** A file, as base64 bytes. */
  raw?: string;
  /** The part's media type. */
  mediaType?: string;
  /** A file's name. */
  filename?: string;
  /** Anything else. */
  metadata?: Record<string, unknown>;
}

/** A message between agents. */
export interface A2aMessage {
  /** Its id. */
  messageId: string;
  /** Who it is from. */
  role: A2aRole;
  /** What it says. */
  parts: A2aPart[];
  /** The conversation it belongs to. */
  contextId?: string;
  /** The task it continues, when it answers one. */
  taskId?: string;
  /** Anything else. */
  metadata?: Record<string, unknown>;
}

/** What a task produced. */
export interface A2aArtifact {
  /** Its id. */
  artifactId: string;
  /** Its name. */
  name?: string;
  /** Its content. */
  parts: A2aPart[];
}

/** A unit of work an agent was asked to do. */
export interface A2aTask {
  /** Its id. */
  id: string;
  /** The conversation it belongs to. */
  contextId: string;
  /** Where it stands, with the agent's latest message. */
  status: { state: A2aTaskState; message?: A2aMessage; timestamp?: string };
  /** What it produced. */
  artifacts?: A2aArtifact[];
  /** The messages exchanged, when asked for. */
  history?: A2aMessage[];
  /** Anything else. */
  metadata?: Record<string, unknown>;
}

/** A skill an agent card advertises. */
export interface A2aSkill {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** What it does. */
  description: string;
  /** Labels for discovery. */
  tags: string[];
  /** Example requests. */
  examples?: string[];
}

/** What an agent publishes about itself at `/.well-known/agent-card.json`. */
export interface A2aAgentCard {
  /** Its name. */
  name: string;
  /** What it does. */
  description: string;
  /** Its version. */
  version: string;
  /** Who provides it. */
  provider?: { organization: string; url?: string };
  /** Where it is reached, and how. */
  supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
  /** What it supports. */
  capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard: boolean };
  /** Media types it accepts. */
  defaultInputModes: string[];
  /** Media types it produces. */
  defaultOutputModes: string[];
  /** What it can do. */
  skills: A2aSkill[];
}

/** A streamed event: a task, a status change, or a piece of an artifact. */
export type A2aStreamEvent =
  | { task: A2aTask }
  | { message: A2aMessage }
  | { statusUpdate: { taskId: string; contextId: string; status: A2aTask['status'] } }
  | {
      artifactUpdate: {
        taskId: string;
        contextId: string;
        artifact: A2aArtifact;
        append?: boolean;
        lastChunk?: boolean;
      };
    };

/** A2A's error codes, beside JSON-RPC's own. */
export const A2A_ERRORS = {
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
  versionNotSupported: -32009,
} as const;

/** Raised by the client when an agent answers with a JSON-RPC error. */
export class A2aError extends Error {
  constructor(
    /** The JSON-RPC error code. */
    readonly code: number,
    message: string,
    /** The error's data, when the agent sent any. */
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'A2aError';
  }
}

/** Options for `a2aHandler()`. */
export interface A2aServerOptions {
  /** The card's content: the endpoint `url` is where this handler is mounted. */
  card: Omit<A2aAgentCard, 'supportedInterfaces' | 'capabilities' | 'defaultInputModes' | 'defaultOutputModes'> & {
    url: string;
    defaultInputModes?: string[];
    defaultOutputModes?: string[];
  };
  /** The graph input for a task. Defaults to `{ messages }`: the context's conversation and the new message. */
  input?: (message: A2aMessage, history: Message[]) => unknown;
  /**
   * The answer a message gives a paused task's question. Defaults to its first data part's value,
   * such as `{ approved: true }` for a tool approval, or else its text. Text answering an approval is
   * read as words: yes, ok, allow, approve, or confirm allows, and anything else refuses.
   */
  answer?: (message: A2aMessage, interrupt: ProtocolInterrupt) => unknown;
  /** Who the task is for, from the request: the place to authenticate the calling agent. */
  principal?: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
  /** Most tasks and contexts kept in memory. Defaults to 10,000 each. */
  maxTasks?: number;
}

interface TaskRecord {
  task: A2aTask;
  history: A2aMessage[];
  controller: AbortController;
  interrupts?: ProtocolInterrupt[];
}

const TERMINAL = new Set<A2aTaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/**
 * An HTTP handler that serves a graph as an A2A agent: `GET` the card, `POST` JSON-RPC. Mount it
 * at the card's `url`; it answers the well-known card path under the same origin too.
 *
 * ```ts
 * const handler = a2aHandler(agent, {
 *   card: { name: 'Researcher', description: 'Answers research questions', version: '1.0.0', url: 'https://agents.example.com/a2a', skills: [] },
 * });
 * ```
 */
export function a2aHandler(graph: ProtocolGraph, options: A2aServerOptions): (request: Request) => Promise<Response> {
  const card: A2aAgentCard = {
    name: options.card.name,
    description: options.card.description,
    version: options.card.version,
    ...(options.card.provider ? { provider: options.card.provider } : {}),
    supportedInterfaces: [{ url: options.card.url, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: options.card.defaultInputModes ?? ['text/plain', 'application/json'],
    defaultOutputModes: options.card.defaultOutputModes ?? ['text/plain'],
    skills: options.card.skills,
  };
  const max = options.maxTasks ?? 10_000;
  const tasks = new Map<string, TaskRecord>();
  const contexts = new Map<string, Message[]>();
  const remember = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value as string);
  };
  const answer =
    options.answer ??
    ((message: A2aMessage, interrupt: ProtocolInterrupt) => {
      const data = message.parts.find((part) => part.data !== undefined);
      if (data) return data.data;
      const text = message.parts.map((part) => part.text ?? '').join('\n');
      return toolCallOf(interrupt) ? approvalOf(text) : text;
    });

  /** Runs, or resumes, the graph for a task, reporting text as it streams. */
  const execute = async (
    record: TaskRecord,
    message: A2aMessage,
    principal: Principal | undefined,
    onText?: (delta: string) => void,
  ): Promise<void> => {
    const task = record.task;
    const runOptions: ProtocolRunOptions = {
      threadId: task.id,
      signal: record.controller.signal,
      ...(principal ? { principal } : {}),
      ...(onText
        ? {
            onEvent: (event: GraphEvent) => {
              if (event.type === 'message' && !event.namespace && event.chunk.kind !== 'reasoning')
                onText(event.chunk.content);
            },
          }
        : {}),
    };
    setStatus(task, 'TASK_STATE_WORKING');
    try {
      let result: ProtocolResult;
      if (record.interrupts?.length) {
        const answers = Object.fromEntries(
          record.interrupts.map((interrupt) => [interrupt.id, answer(message, interrupt)]),
        );
        record.interrupts = undefined;
        result = await graph.resumeInterruptsWith(task.id, answers, runOptions);
      } else {
        const history = contexts.get(task.contextId) ?? [];
        const said = messageOf('user', textOfParts(message.parts));
        result = await graph.invoke(
          options.input ? options.input(message, history) : { messages: [...history, said] },
          runOptions,
        );
        remember(contexts, task.contextId, [...history, said]);
      }
      if (record.controller.signal.aborted) return;
      if (result.status === 'awaiting_input' && result.interrupts?.length) {
        record.interrupts = result.interrupts;
        setStatus(
          task,
          'TASK_STATE_INPUT_REQUIRED',
          agentMessage(task, result.interrupts.map((item) => item.reason ?? 'Input is required').join('\n'), {
            interrupts: result.interrupts,
          }),
        );
      } else {
        const text = answerOf(result.state);
        const reply = agentMessage(task, text);
        record.history.push(reply);
        const before = contexts.get(task.contextId) ?? [];
        remember(contexts, task.contextId, transcriptOf(result.state, [...before, messageOf('assistant', text)]));
        task.artifacts = [{ artifactId: `${task.id}:answer`, name: 'answer', parts: [{ text }] }];
        setStatus(task, 'TASK_STATE_COMPLETED', reply);
      }
    } catch (error) {
      if (record.controller.signal.aborted) return;
      setStatus(task, 'TASK_STATE_FAILED', agentMessage(task, error instanceof Error ? error.message : String(error)));
    }
  };

  /** The task a message starts, or the paused one it answers. */
  const taskFor = (message: A2aMessage): TaskRecord | { error: number; message: string } => {
    if (message.taskId) {
      const existing = tasks.get(message.taskId);
      if (!existing) return { error: A2A_ERRORS.taskNotFound, message: `Task ${message.taskId} was not found` };
      if (existing.task.status.state !== 'TASK_STATE_INPUT_REQUIRED') {
        return { error: A2A_ERRORS.unsupportedOperation, message: `Task ${message.taskId} is not waiting for input` };
      }
      existing.history.push(message);
      existing.controller = new AbortController();
      return existing;
    }
    const contextId = message.contextId ?? protocolId('context');
    const task: A2aTask = {
      id: protocolId('task'),
      contextId,
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
    };
    const record: TaskRecord = {
      task,
      history: [{ ...message, contextId, taskId: task.id }],
      controller: new AbortController(),
    };
    remember(tasks, task.id, record);
    return record;
  };

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (url.pathname.endsWith('/.well-known/agent-card.json') || url.pathname.endsWith('/agent-card.json')) {
        return Response.json(card);
      }
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'POST')
      return new Response('A2A calls are POSTed', { status: 405, headers: { allow: 'GET, POST' } });
    const version = request.headers.get('a2a-version');
    let call: { jsonrpc?: string; id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      call = (await request.json()) as typeof call;
    } catch {
      return rpcError(null, -32700, 'The body is not JSON');
    }
    const id = call.id ?? null;
    if (call.jsonrpc !== '2.0' || typeof call.method !== 'string')
      return rpcError(id, -32600, 'Not a JSON-RPC 2.0 request');
    if (version && !version.startsWith('1.')) {
      return rpcError(
        id,
        A2A_ERRORS.versionNotSupported,
        `This agent speaks A2A ${A2A_PROTOCOL_VERSION}, not ${version}`,
      );
    }
    const params = call.params ?? {};
    const principal = await options.principal?.(request);

    switch (call.method) {
      case 'SendMessage':
      case 'SendStreamingMessage': {
        const message = params.message as A2aMessage | undefined;
        if (!message || !Array.isArray(message.parts))
          return rpcError(id, -32602, 'params.message with parts is required');
        const record = taskFor(message);
        if ('error' in record) return rpcError(id, record.error, record.message);
        if (call.method === 'SendMessage') {
          const configuration = (params.configuration ?? {}) as { returnImmediately?: boolean; historyLength?: number };
          const running = execute(record, message, principal);
          if (!configuration.returnImmediately) await running;
          return rpcResult(id, { task: view(record, configuration.historyLength) });
        }
        return streamTask(id, record, (onText) => execute(record, message, principal, onText));
      }
      case 'GetTask': {
        const record = tasks.get(String(params.id ?? ''));
        if (!record) return rpcError(id, A2A_ERRORS.taskNotFound, `Task ${String(params.id)} was not found`);
        return rpcResult(id, view(record, typeof params.historyLength === 'number' ? params.historyLength : undefined));
      }
      case 'CancelTask': {
        const record = tasks.get(String(params.id ?? ''));
        if (!record) return rpcError(id, A2A_ERRORS.taskNotFound, `Task ${String(params.id)} was not found`);
        if (TERMINAL.has(record.task.status.state)) {
          return rpcError(id, A2A_ERRORS.taskNotCancelable, `Task ${record.task.id} has already finished`);
        }
        record.controller.abort(new Error('Cancelled by the calling agent'));
        setStatus(record.task, 'TASK_STATE_CANCELED');
        return rpcResult(id, view(record));
      }
      default:
        return rpcError(id, -32601, `Method ${call.method} is not supported`);
    }
  };
}

/** A task as returned, with as much of its history as was asked for. */
function view(record: TaskRecord, historyLength?: number): A2aTask {
  return {
    ...record.task,
    ...(historyLength === undefined || historyLength <= 0 ? {} : { history: record.history.slice(-historyLength) }),
  };
}

function streamTask(
  id: unknown,
  record: TaskRecord,
  run: (onText: (delta: string) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const task = record.task;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (result: A2aStreamEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`));
      send({ task: { ...task } });
      let streamed = false;
      await run((delta) => {
        if (!delta) return;
        send({
          artifactUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            artifact: { artifactId: `${task.id}:answer`, name: 'answer', parts: [{ text: delta }] },
            append: streamed,
          },
        });
        streamed = true;
      });
      if (streamed) {
        send({
          artifactUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            artifact: { artifactId: `${task.id}:answer`, name: 'answer', parts: [] },
            append: true,
            lastChunk: true,
          },
        });
      }
      send({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } });
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

function setStatus(task: A2aTask, state: A2aTaskState, message?: A2aMessage): void {
  task.status = { state, ...(message ? { message } : {}), timestamp: new Date().toISOString() };
}

function agentMessage(task: A2aTask, text: string, data?: unknown): A2aMessage {
  return {
    messageId: protocolId('message'),
    role: 'ROLE_AGENT',
    parts: [{ text }, ...(data === undefined ? [] : [{ data }])],
    contextId: task.contextId,
    taskId: task.id,
  };
}

function textOfParts(parts: readonly A2aPart[]): string {
  return parts
    .map((part) => (part.text !== undefined ? part.text : part.data !== undefined ? JSON.stringify(part.data) : ''))
    .filter(Boolean)
    .join('\n');
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── The client ──────────────────────────────────────────────────────

/** Options for `a2aClient()`. */
export interface A2aClientOptions {
  /** The agent: its card's URL, or its JSON-RPC endpoint, whose origin serves the card. */
  url: string;
  /** Replaces the global `fetch`, for authentication, a proxy, or tests. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request, such as an authorization header. */
  headers?: Record<string, string>;
}

/** What to send: text, and optionally data, a conversation, or the paused task it answers. */
export interface A2aSendOptions {
  /** The conversation to continue. */
  contextId?: string;
  /** The paused task this message answers. */
  taskId?: string;
  /** Structured data sent beside the text, such as `{ approved: true }`. */
  data?: unknown;
  /** Cancels the request. */
  signal?: AbortSignal;
}

/** A client for one A2A agent. */
export interface A2aClient {
  /** The agent's card, fetched once. */
  card(): Promise<A2aAgentCard>;
  /** Sends a message and waits for the task it starts or continues. */
  send(text: string, options?: A2aSendOptions): Promise<A2aTask>;
  /** Sends a message and reads the task's events as they arrive. */
  stream(text: string, options?: A2aSendOptions): AsyncGenerator<A2aStreamEvent>;
  /** Reads a task. */
  getTask(taskId: string, historyLength?: number): Promise<A2aTask>;
  /** Cancels a task. */
  cancel(taskId: string): Promise<A2aTask>;
}

/** A client for an A2A agent, by its card or endpoint URL. */
export function a2aClient(options: A2aClientOptions): A2aClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const isCard = /agent-card\.json$/.test(options.url);
  const cardUrl = isCard ? options.url : `${new URL(options.url).origin}/.well-known/agent-card.json`;
  let cached: Promise<A2aAgentCard> | undefined;
  const card = () => {
    cached ??= fetcher(cardUrl, { headers: { accept: 'application/json', ...options.headers } }).then(
      async (response) => {
        if (!response.ok) throw new A2aError(response.status, `The agent card answered ${response.status}`);
        return (await response.json()) as A2aAgentCard;
      },
    );
    return cached;
  };
  const endpoint = async () =>
    isCard
      ? ((await card()).supportedInterfaces.find((item) => item.protocolBinding === 'JSONRPC')?.url ?? options.url)
      : options.url;
  let ids = 0;
  const post = async (method: string, params: unknown, signal?: AbortSignal) =>
    fetcher(await endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': A2A_PROTOCOL_VERSION, ...options.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method, params }),
      ...(signal ? { signal } : {}),
    });
  const call = async <T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await post(method, params, signal);
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new A2aError(body.error.code, body.error.message, body.error.data);
    return body.result as T;
  };
  const message = (text: string, send: A2aSendOptions): A2aMessage => ({
    messageId: protocolId('message'),
    role: 'ROLE_USER',
    parts: [{ text }, ...(send.data === undefined ? [] : [{ data: send.data }])],
    ...(send.contextId ? { contextId: send.contextId } : {}),
    ...(send.taskId ? { taskId: send.taskId } : {}),
  });

  return {
    card,
    async send(text, send = {}) {
      const result = await call<{ task?: A2aTask; message?: A2aMessage }>(
        'SendMessage',
        { message: message(text, send), configuration: { returnImmediately: false } },
        send.signal,
      );
      if (result.task) return result.task;
      // An agent may answer with a message alone; it is a finished task with no id of its own.
      const reply = result.message as A2aMessage;
      return {
        id: reply.taskId ?? '',
        contextId: reply.contextId ?? send.contextId ?? '',
        status: { state: 'TASK_STATE_COMPLETED', message: reply },
        artifacts: [{ artifactId: 'message', parts: reply.parts }],
      };
    },
    async *stream(text, send = {}) {
      const response = await post('SendStreamingMessage', { message: message(text, send) }, send.signal);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (data) {
            const parsed = JSON.parse(data) as { result?: A2aStreamEvent; error?: { code: number; message: string } };
            if (parsed.error) throw new A2aError(parsed.error.code, parsed.error.message);
            if (parsed.result) yield parsed.result;
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    },
    getTask: (taskId, historyLength) =>
      call<A2aTask>('GetTask', { id: taskId, ...(historyLength ? { historyLength } : {}) }),
    cancel: (taskId) => call<A2aTask>('CancelTask', { id: taskId }),
  };
}

/** Options for `a2aTool()`. */
export interface A2aToolOptions extends A2aClientOptions {
  /** The tool's name, as the model calls it. */
  name: string;
  /** What the remote agent does, written for the model that decides when to call it. */
  description: string;
}

/**
 * A remote A2A agent as a tool another agent can call. Each call is a task, and the remote agent's
 * answer is the result; a remote task that needs input reports its question, which the model can
 * answer by calling again with `taskId`. The tool declares the host it reaches, as
 * `network:<host>`, so a permission policy grants or denies it like any other.
 */
export function a2aTool(options: A2aToolOptions): ToolDefinition {
  const client = a2aClient(options);
  const host = new URL(options.url).host;
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the agent should do, with everything it needs to know.' },
        contextId: { type: 'string', description: 'Continues an earlier conversation with this agent.' },
        taskId: { type: 'string', description: 'Answers a question the agent asked about this task.' },
      },
      required: ['task'],
    },
    capabilities: [`network:${host}`],
    execute: async (args, context) => {
      const task = await client.send(String(args.task ?? ''), {
        ...(typeof args.contextId === 'string' ? { contextId: args.contextId } : {}),
        ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      const text = (task.artifacts ?? [])
        .flatMap((artifact) => artifact.parts.map((part) => part.text ?? ''))
        .join('\n');
      const said = (task.status.message?.parts ?? []).map((part) => part.text ?? '').join('\n');
      return {
        state: task.status.state,
        taskId: task.id,
        contextId: task.contextId,
        answer: task.status.state === 'TASK_STATE_COMPLETED' ? text || said : said,
      };
    },
  };
}
