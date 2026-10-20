/**
 * A2A, the Agent2Agent protocol (version 1.0): a Nexus agent served to remote agents, and remote
 * agents called from a Nexus agent.
 *
 * The server publishes an agent card at `/.well-known/agent-card.json` and answers over the
 * protocol's bindings: JSON-RPC 2.0 at the card's URL, HTTP+JSON at routes under it, and gRPC through
 * `nexus-ai-pro/protocols/a2a/grpc`, every one over the same tasks:
 * - `SendMessage`, and `SendStreamingMessage` with its events;
 * - `GetTask`, `ListTasks`, `SubscribeToTask`, and `CancelTask`;
 * - push notification configs, when it pushes, and `GetExtendedAgentCard`, when it has one.
 *
 * Tasks live in an `A2aTaskStore`: memory by default, or any long-term store, so a restart or another
 * replica picks a task up.
 *
 * A task that pauses for an answer is `TASK_STATE_INPUT_REQUIRED`, and a message naming the task
 * resumes it. The client and `a2aTool()` speak the same protocol to any A2A agent. A remote agent is
 * then one more tool, which declares the host it reaches, so a permission policy decides it.
 */
import type { GraphEvent, GraphToolEvent } from '../types/graph.js';
import type { Message, ToolDefinition } from '../types/messages.js';
import type { Principal } from '../types/principal.js';
import type { Store } from '../types/store.js';
import {
  answerOf,
  approvalOf,
  asText,
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
  supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string; tenant?: string }>;
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
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  extendedCardNotConfigured: -32007,
  versionNotSupported: -32009,
} as const;

/** Raised by a client when an agent answers with an error, on any binding, as A2A's code. */
export class A2aError extends Error {
  constructor(
    /** The error's JSON-RPC code: on HTTP+JSON and gRPC, the code of its `ErrorInfo` reason. */
    readonly code: number,
    message: string,
    /** The error's data, when the agent sent any. */
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'A2aError';
  }
}

// ── Tasks, kept ─────────────────────────────────────────────────────

/** Where a task's updates are pushed: a webhook the calling agent gave. */
export interface A2aPushNotificationConfig {
  /** Its id, unique within the task. Given one when it has none. */
  id?: string;
  /** Where each update is POSTed. */
  url: string;
  /** Sent back as the `X-A2A-Notification-Token` header, so the receiver knows the update is its own. */
  token?: string;
  /** Sent as the `Authorization` header of each delivery, `<scheme> <credentials>`, such as a bearer token. */
  authentication?: { scheme: string; credentials?: string };
}

/** A task as a store keeps it: the task, its messages, the questions it waits on, and its webhooks. */
export interface A2aTaskRecord {
  /** The task. */
  task: A2aTask;
  /** Every message of the task, the caller's and the agent's. */
  history: A2aMessage[];
  /** The questions the paused run asked, which the next message answers. */
  interrupts?: ProtocolInterrupt[];
  /** Where its updates are pushed. */
  push?: A2aPushNotificationConfig[];
  /** ISO-8601 time it was last written. */
  updatedAt: string;
  /**
   * Who is running the task, and until when, while it works. The replica running it renews the lease;
   * once it lapses, another replica's `recover()` may take the task over.
   */
  lease?: A2aTaskLease;
  /** What the working run was asked to do, so a replica that takes it over can carry it on. */
  run?: A2aTaskRun;
  /** Bumped by every claim of the lease, so two replicas claiming one task cannot both win. */
  version?: number;
}

/** A replica's hold on a working task. */
export interface A2aTaskLease {
  /** The replica holding it. */
  owner: string;
  /** ISO-8601 time it lapses unless renewed. */
  expiresAt: string;
}

/** A working run, as kept with its task: started by a message, or answering the task's questions. */
export interface A2aTaskRun {
  /** `invoke` for a run a message started, `resume` for one answering a paused task's questions. */
  kind: 'invoke' | 'resume';
  /** The message that started it. */
  message: A2aMessage;
  /** The answers it resumed with, by interrupt id. */
  answers?: Record<string, unknown>;
  /** Who it runs for. */
  principal?: Principal;
}

/** Which tasks `A2aTaskStore.list()` returns. */
export interface A2aTaskQuery {
  /** Only this conversation's. */
  contextId?: string;
  /** Only those in this state. */
  state?: A2aTaskState;
  /** Most returned. */
  limit: number;
  /** Skipped first, for paging. */
  offset: number;
}

/**
 * Where an A2A agent keeps its tasks and conversations. A store outside the process lets a restart, or
 * another replica, pick a task up: answer a task's question, read it, list it, or cancel it.
 */
export interface A2aTaskStore {
  /** A task's record. */
  get(taskId: string): Promise<A2aTaskRecord | undefined> | A2aTaskRecord | undefined;
  /** Writes a task's record. */
  put(record: A2aTaskRecord): Promise<void> | void;
  /** Tasks, most recently written first, and how many match when the store knows. */
  list(
    query: A2aTaskQuery,
  ): Promise<{ records: A2aTaskRecord[]; total?: number }> | { records: A2aTaskRecord[]; total?: number };
  /** A conversation's transcript, as the agent last left it. */
  conversation(contextId: string): Promise<Message[] | undefined> | Message[] | undefined;
  /** Writes a conversation's transcript. */
  saveConversation(contextId: string, messages: Message[]): Promise<void> | void;
  /**
   * Takes, or renews, the lease of a working task, or of one submitted and not yet started, in one
   * step: when the task has no lease, its lease has lapsed by `lease.now`, or `lease.owner` already
   * holds it. Resolves to the record as claimed,
   * or `undefined` when another replica holds it. Optional; without it, a claim is a read and a write,
   * and two replicas recovering at once may both take one task.
   */
  claim?(
    taskId: string,
    lease: A2aTaskLease & { now: string },
  ): Promise<A2aTaskRecord | undefined> | A2aTaskRecord | undefined;
}

/**
 * Whether a lease may be taken: the task works, or was submitted and not yet started, and no other
 * replica holds it now.
 */
function claimable(record: A2aTaskRecord | undefined, lease: A2aTaskLease & { now: string }): boolean {
  if (!record) return false;
  const state = record.task.status.state;
  return (
    (state === 'TASK_STATE_WORKING' || state === 'TASK_STATE_SUBMITTED') &&
    (!record.lease || record.lease.owner === lease.owner || record.lease.expiresAt <= lease.now)
  );
}

/** A record with a lease taken, its version bumped. */
function claimed(record: A2aTaskRecord, lease: A2aTaskLease): A2aTaskRecord {
  return { ...record, lease: { owner: lease.owner, expiresAt: lease.expiresAt }, version: (record.version ?? 0) + 1 };
}

/** Tasks and conversations in this process: the default, for one replica. */
export class MemoryA2aTaskStore implements A2aTaskStore {
  private readonly tasks = new Map<string, A2aTaskRecord>();
  private readonly conversations = new Map<string, Message[]>();
  private readonly max: number;

  constructor(options: { maxTasks?: number } = {}) {
    this.max = options.maxTasks ?? 10_000;
  }

  /** A task's record, as a copy. */
  get(taskId: string): A2aTaskRecord | undefined {
    const record = this.tasks.get(taskId);
    return record ? structuredClone(record) : undefined;
  }

  /** Writes a task's record, dropping the least recently written beyond `maxTasks`. */
  put(record: A2aTaskRecord): void {
    remember(this.tasks, record.task.id, structuredClone(record), this.max);
  }

  /** Tasks, most recently written first, with how many match. */
  list(query: A2aTaskQuery): { records: A2aTaskRecord[]; total: number } {
    const matching = [...this.tasks.values()]
      .filter(
        (record) =>
          (query.contextId === undefined || record.task.contextId === query.contextId) &&
          (query.state === undefined || record.task.status.state === query.state),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      records: matching.slice(query.offset, query.offset + query.limit).map((record) => structuredClone(record)),
      total: matching.length,
    };
  }

  /** A conversation's transcript. */
  conversation(contextId: string): Message[] | undefined {
    const messages = this.conversations.get(contextId);
    return messages ? structuredClone(messages) : undefined;
  }

  /** Writes a conversation's transcript. */
  saveConversation(contextId: string, messages: Message[]): void {
    remember(this.conversations, contextId, structuredClone(messages), this.max);
  }

  /** Takes or renews a working task's lease, in one step. */
  claim(taskId: string, lease: A2aTaskLease & { now: string }): A2aTaskRecord | undefined {
    const record = this.tasks.get(taskId);
    if (!record || !claimable(record, lease)) return undefined;
    const next = claimed(record, lease);
    this.tasks.set(taskId, next);
    return structuredClone(next);
  }
}

/**
 * Tasks and conversations in any long-term `Store`: the memory, Redis, Postgres, or SQLite store, so
 * every replica sees one set. Listing filters on the task's fields in the store; it does not count
 * all matches, so `total` is unknown.
 */
export function storeA2aTasks(store: Store, options: { namespace?: readonly string[] } = {}): A2aTaskStore {
  const base = [...(options.namespace ?? ['nexus', 'a2a'])];
  const tasks = [...base, 'tasks'];
  const conversations = [...base, 'conversations'];
  return {
    async get(taskId) {
      return (await store.get<A2aTaskRecord>(tasks, taskId))?.value;
    },
    async put(record) {
      await store.put(tasks, record.task.id, record);
    },
    async list(query) {
      const filter: Record<string, unknown> = {
        ...(query.contextId === undefined ? {} : { 'task.contextId': query.contextId }),
        ...(query.state === undefined ? {} : { 'task.status.state': query.state }),
      };
      const items = await store.search<A2aTaskRecord>(tasks, {
        limit: query.limit,
        offset: query.offset,
        ...(Object.keys(filter).length ? { filter } : {}),
      });
      return { records: items.map((item) => item.value) };
    },
    async conversation(contextId) {
      return (await store.get<{ messages: Message[] }>(conversations, contextId))?.value.messages;
    },
    async saveConversation(contextId, messages) {
      await store.put(conversations, contextId, { messages });
    },
    // A compare-and-set on the record's version where the store has one, so of two replicas claiming
    // a task at once, one wins; otherwise a read and a write.
    async claim(taskId, lease) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = (await store.get<A2aTaskRecord>(tasks, taskId))?.value;
        if (!current || !claimable(current, lease)) return undefined;
        const next = claimed(current, lease);
        if (!store.putIfVersion) {
          await store.put(tasks, taskId, next);
          return next;
        }
        // A record written before tasks had versions gets one first, then is claimed as any other.
        if (current.version === undefined) {
          await store.put(tasks, taskId, { ...current, version: 0 });
          continue;
        }
        if (await store.putIfVersion(tasks, taskId, next as A2aTaskRecord & { version: number }, current.version)) {
          return next;
        }
      }
      return undefined;
    },
  };
}

// ── The server ──────────────────────────────────────────────────────

/** Options for pushing task updates to the webhooks callers give. */
export interface A2aPushOptions {
  /**
   * Signs every delivery with an \`x-nexus-signature\` header, as the server's operation webhooks are,
   * so a receiver checks it with \`verifyOperationWebhook()\` from \`nexus-ai-pro/operations\`.
   */
  secret?: string;
  /**
   * Allows webhooks on loopback, private, and link-local addresses, and plain \`http\`. Off by default,
   * so a caller cannot make the agent reach into its own network. Turn it on for tests, or when every
   * caller is trusted.
   */
  allowPrivateNetworks?: boolean;
  /** Replaces \`fetch\` for deliveries: a client with its own address checks, a proxy, or a test. */
  fetch?: typeof globalThis.fetch;
  /** How long one delivery may take, in milliseconds. Defaults to 5 seconds. */
  timeoutMs?: number;
  /**
   * Pushes the answer's text as it is written too, each piece as an `artifactUpdate`, in order with
   * the task's changes of state: so a caller that cannot hold a stream open still sees the answer
   * arrive. `everyMs` gathers the pieces written within that many milliseconds into one delivery.
   * Off by default: only changes of state are pushed.
   */
  text?: boolean | { everyMs?: number };
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
  /**
   * Where tasks and conversations are kept. Defaults to memory, for one replica; \`storeA2aTasks()\`
   * keeps them in a shared store. A task resumed elsewhere needs the graph's own checkpointer to be
   * shared too.
   */
  store?: A2aTaskStore;
  /** Most tasks and contexts the default memory store keeps. Defaults to 10,000 each. */
  maxTasks?: number;
  /** Pushes each task's updates to the webhooks callers give. Without it, push notifications are not offered. */
  pushNotifications?: A2aPushOptions;
  /**
   * The extended card an authenticated caller may read with `GetExtendedAgentCard`: more skills, or
   * anything else this caller may see. Without it, there is no extended card.
   */
  extendedCard?: (principal: Principal) => Partial<A2aAgentCard> | Promise<Partial<A2aAgentCard>>;
  /** How often `SubscribeToTask` reads a task another replica runs, in milliseconds. Defaults to 1 second. */
  pollMs?: number;
  /**
   * The lease a replica holds on each task it runs: renewed every third of `ms` (30 seconds by
   * default), and taken over by another replica's `recover()` once it lapses. `owner` names this
   * replica; it defaults to a random id.
   */
  lease?: { ms?: number; owner?: string };
  /**
   * Runs `recover()` every this many milliseconds, so a task a stopped replica was working on is taken
   * over without a caller asking. Off by default; `close()` stops it.
   */
  recoverEveryMs?: number;
  /** Receives push delivery failures, which never fail a task. */
  onError?: (error: unknown) => void;
  /**
   * The bindings this handler answers, as its card lists them: `JSONRPC`, POSTed to the card's `url`,
   * and `HTTP+JSON`, its routes under that URL, such as `<url>/message:send`. Defaults to both.
   */
  bindings?: ReadonlyArray<'JSONRPC' | 'HTTP+JSON'>;
  /**
   * More interfaces the card lists, after this handler's own: the gRPC service
   * `nexus-ai-pro/protocols/a2a/grpc` serves over this handler, as `{ url: 'agents.example.com:443',
   * protocolBinding: 'GRPC' }`, or a binding of your own.
   */
  interfaces?: ReadonlyArray<{ url: string; protocolBinding: string; protocolVersion?: string; tenant?: string }>;
}

/** The binding a call arrived on. */
export type A2aBinding = 'JSONRPC' | 'HTTP+JSON' | 'GRPC' | (string & {});

/** Who a call is for, and what carries it. */
export interface A2aCallContext {
  /** The caller, as `A2aServerOptions.principal` read them. */
  principal?: Principal;
  /** Stops a stream when the caller goes away. */
  signal?: AbortSignal;
  /**
   * The binding, which shapes a push config's answer: JSON-RPC's carries the config both flat, as
   * protocol 1.0 has it, and as the `pushNotificationConfig` the drafts had. Defaults to `JSONRPC`.
   */
  binding?: A2aBinding;
}

/** What one A2A call answers, whatever binding carries it: a result, an error, or a stream of events. */
export type A2aCallOutcome =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { events: ReadableStream<A2aStreamEvent> };

/** An A2A error, as each binding carries it: its HTTP status, its gRPC status, and its reason. */
export interface A2aErrorStatus {
  /** The HTTP status of the HTTP+JSON binding. */
  httpStatus: number;
  /** The gRPC status code's name, such as `NOT_FOUND`. */
  grpcStatus: string;
  /** The `google.rpc.ErrorInfo` reason, such as `TASK_NOT_FOUND`. */
  reason: string;
}

const ERROR_STATUS: Record<number, A2aErrorStatus> = {
  [-32001]: { httpStatus: 404, grpcStatus: 'NOT_FOUND', reason: 'TASK_NOT_FOUND' },
  [-32002]: { httpStatus: 409, grpcStatus: 'FAILED_PRECONDITION', reason: 'TASK_NOT_CANCELABLE' },
  [-32003]: { httpStatus: 400, grpcStatus: 'UNIMPLEMENTED', reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' },
  [-32004]: { httpStatus: 400, grpcStatus: 'UNIMPLEMENTED', reason: 'UNSUPPORTED_OPERATION' },
  [-32005]: { httpStatus: 415, grpcStatus: 'INVALID_ARGUMENT', reason: 'CONTENT_TYPE_NOT_SUPPORTED' },
  [-32006]: { httpStatus: 502, grpcStatus: 'INTERNAL', reason: 'INVALID_AGENT_RESPONSE' },
  [-32007]: { httpStatus: 400, grpcStatus: 'FAILED_PRECONDITION', reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED' },
  [-32008]: { httpStatus: 400, grpcStatus: 'FAILED_PRECONDITION', reason: 'EXTENSION_SUPPORT_REQUIRED' },
  [-32009]: { httpStatus: 400, grpcStatus: 'UNIMPLEMENTED', reason: 'VERSION_NOT_SUPPORTED' },
  [-32700]: { httpStatus: 400, grpcStatus: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' },
  [-32600]: { httpStatus: 400, grpcStatus: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' },
  [-32601]: { httpStatus: 404, grpcStatus: 'UNIMPLEMENTED', reason: 'METHOD_NOT_FOUND' },
  [-32602]: { httpStatus: 400, grpcStatus: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' },
};

/** How an error code is carried on the HTTP+JSON and gRPC bindings, as protocol 1.0 maps them. */
export function a2aErrorStatus(code: number): A2aErrorStatus {
  return ERROR_STATUS[code] ?? { httpStatus: 500, grpcStatus: 'INTERNAL', reason: 'INTERNAL_ERROR' };
}

/** The error code of an `ErrorInfo` reason, the way back: `TASK_NOT_FOUND` is -32001. */
export function a2aErrorCode(reason: string | undefined, fallback = -32603): number {
  for (const [code, status] of Object.entries(ERROR_STATUS)) if (status.reason === reason) return Number(code);
  return fallback;
}

/** What one `recover()` did. */
export interface A2aRecoveryReport {
  /** Tasks whose lease had lapsed, taken over and carried on here. */
  tookOver: string[];
  /** Tasks another replica claimed first, or that finished meanwhile. */
  skipped: number;
}

/**
 * An A2A agent's HTTP handler, with what keeps its tasks alive across replicas: `recover()` takes over
 * the working tasks whose replica stopped renewing their lease, and `close()` stops the recovery timer.
 */
export interface A2aHandler {
  /** Answers one HTTP request: `GET` the card, a JSON-RPC `POST`, or an HTTP+JSON route under the card's URL. */
  (request: Request): Promise<Response>;
  /** This replica's name in the leases it holds. */
  readonly owner: string;
  /**
   * Takes over working tasks whose lease lapsed, up to `limit` (10), and carries each on: from the
   * graph's last checkpoint, by answering its questions again when the run was a resume that never
   * reached the graph, or from the start when the run left no checkpoint. Resolves once they are
   * claimed, not finished.
   */
  recover(options?: { limit?: number }): Promise<A2aRecoveryReport>;
  /** Stops the recovery timer `recoverEveryMs` started. Tasks running here carry on. */
  close(): void;
  /**
   * Runs one method by its name, with its params as protocol 1.0's JSON has them: what every binding
   * does, and so how another binding is served over the same tasks, as the gRPC service is.
   */
  call(method: string, params: Record<string, unknown>, context?: A2aCallContext): Promise<A2aCallOutcome>;
  /** The card this handler serves. */
  readonly card: A2aAgentCard;
  /** Who a request is for, as `A2aServerOptions.principal` reads it: for a binding of your own to call with. */
  authenticate(request: Request): Promise<Principal | undefined>;
}

/** Where a running task's events go: every stream and subscriber following it here. */
type Listener = (event: A2aStreamEvent) => void;

const TERMINAL = new Set<A2aTaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/** Every task state, for checking a filter. */
const TASK_STATES = new Set<A2aTaskState>([
  ...TERMINAL,
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

/** A status a stream or subscription ends on: one where the task stops, or waits. */
const settled = (state: A2aTaskState) => TERMINAL.has(state) || state === 'TASK_STATE_INPUT_REQUIRED';

/**
 * An HTTP handler that serves a graph as an A2A agent: `GET` the card, `POST` JSON-RPC, or call an
 * HTTP+JSON route. Mount it at the card's `url` and every path under it; it answers the well-known card
 * path under the same origin too. Its `call()` serves any other binding, as `a2aGrpcService()` does.
 *
 * ```ts
 * const handler = a2aHandler(agent, {
 *   card: { name: 'Researcher', description: 'Answers research questions', version: '1.0.0', url: 'https://agents.example.com/a2a', skills: [] },
 * });
 * ```
 */
export function a2aHandler(graph: ProtocolGraph, options: A2aServerOptions): A2aHandler {
  const card: A2aAgentCard = {
    name: options.card.name,
    description: options.card.description,
    version: options.card.version,
    ...(options.card.provider ? { provider: options.card.provider } : {}),
    supportedInterfaces: [
      ...(options.bindings ?? ['JSONRPC', 'HTTP+JSON']).map((protocolBinding) => ({
        url: options.card.url,
        protocolBinding,
        protocolVersion: A2A_PROTOCOL_VERSION,
      })),
      ...(options.interfaces ?? []).map((item) => ({
        url: item.url,
        protocolBinding: item.protocolBinding,
        protocolVersion: item.protocolVersion ?? A2A_PROTOCOL_VERSION,
        ...(item.tenant ? { tenant: item.tenant } : {}),
      })),
    ],
    capabilities: {
      streaming: true,
      pushNotifications: Boolean(options.pushNotifications),
      extendedAgentCard: Boolean(options.extendedCard),
    },
    defaultInputModes: options.card.defaultInputModes ?? ['text/plain', 'application/json'],
    defaultOutputModes: options.card.defaultOutputModes ?? ['text/plain'],
    skills: options.card.skills,
  };
  const store = options.store ?? new MemoryA2aTaskStore({ maxTasks: options.maxTasks ?? 10_000 });
  const owner = options.lease?.owner ?? protocolId('replica');
  const leaseMs = options.lease?.ms ?? 30_000;
  const leaseUntil = () => new Date(Date.now() + leaseMs).toISOString();
  /** The tasks this process is running, which a cancel here stops at once. */
  const running = new Map<string, AbortController>();
  const listeners = new Map<string, Set<Listener>>();
  /** Each task's deliveries, in order. */
  const deliveries = new Map<string, Promise<void>>();
  const answer =
    options.answer ??
    ((message: A2aMessage, interrupt: ProtocolInterrupt) => {
      const data = message.parts.find((part) => part.data !== undefined);
      if (data) return data.data;
      const text = message.parts.map((part) => part.text ?? '').join('\n');
      return toolCallOf(interrupt) ? approvalOf(text) : text;
    });

  const publish = (taskId: string, event: A2aStreamEvent) => {
    for (const listener of listeners.get(taskId) ?? []) listener(event);
  };
  const listen = (taskId: string, listener: Listener) => {
    const set = listeners.get(taskId) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(taskId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(taskId);
    };
  };

  /** Text written but not yet pushed, by task, when the pieces are gathered. */
  const pendingText = new Map<
    string,
    { record: A2aTaskRecord; event: A2aStreamEvent; timer: ReturnType<typeof setTimeout> }
  >();
  const textEvery = (() => {
    const text = options.pushNotifications?.text;
    if (!text) return undefined;
    return typeof text === 'object' ? Math.max(0, text.everyMs ?? 0) : 0;
  })();
  /** Pushes the text gathered for a task, before anything after it. */
  const flushText = (taskId: string) => {
    const pending = pendingText.get(taskId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingText.delete(taskId);
    pushNow(pending.record, pending.event);
  };
  /** Pushes a piece of the answer, now or gathered with the pieces after it within `everyMs`. */
  const pushText = (record: A2aTaskRecord, event: Extract<A2aStreamEvent, { artifactUpdate: unknown }>) => {
    if (textEvery === undefined || !record.push?.length) return;
    if (textEvery === 0) return pushNow(record, event);
    const taskId = record.task.id;
    const pending = pendingText.get(taskId);
    if (pending && 'artifactUpdate' in pending.event) {
      const update = pending.event.artifactUpdate;
      const parts = [...update.artifact.parts, ...event.artifactUpdate.artifact.parts];
      const text = parts.map((part) => part.text ?? '').join('');
      pending.event = {
        artifactUpdate: {
          ...update,
          artifact: { ...update.artifact, parts: text ? [{ text }] : [] },
          ...(event.artifactUpdate.lastChunk ? { lastChunk: true } : {}),
        },
      };
      return;
    }
    pendingText.set(taskId, { record, event, timer: setTimeout(() => flushText(taskId), textEvery) });
  };

  /** Posts an update to each of the task's webhooks, after the ones before it. */
  const pushUpdate = (record: A2aTaskRecord, event: A2aStreamEvent) => {
    // Text gathered for the task goes first, so the webhooks see what a stream does, in its order.
    flushText(record.task.id);
    pushNow(record, event);
  };
  const pushNow = (record: A2aTaskRecord, event: A2aStreamEvent) => {
    const push = options.pushNotifications;
    if (!push || !record.push?.length) return;
    const configs = [...record.push];
    const body = JSON.stringify(event);
    const previous = deliveries.get(record.task.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (const config of configs) {
        try {
          await deliver(config, body, push);
        } catch (error) {
          options.onError?.(error);
        }
      }
    });
    deliveries.set(record.task.id, next);
    void next.finally(() => {
      if (deliveries.get(record.task.id) === next) deliveries.delete(record.task.id);
    });
  };

  /** Moves a task to a state: written, then told to every stream, subscriber, and webhook. */
  const changeStatus = async (record: A2aTaskRecord, state: A2aTaskState, message?: A2aMessage) => {
    setStatus(record.task, state, message);
    record.updatedAt = new Date().toISOString();
    await store.put(record);
    const event: A2aStreamEvent = {
      statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status: record.task.status },
    };
    publish(record.task.id, event);
    pushUpdate(record, event);
  };

  /**
   * Claims a working task's lease, or renews the one held. With a store that has no `claim()`, a read
   * and a write.
   */
  const claimLease = async (taskId: string): Promise<A2aTaskRecord | undefined> => {
    const lease = { owner, expiresAt: leaseUntil(), now: new Date().toISOString() };
    if (store.claim) return (await store.claim(taskId, lease)) ?? undefined;
    const current = await store.get(taskId);
    if (!current || !claimable(current, lease)) return undefined;
    const next = claimed(current, lease);
    await store.put(next);
    return next;
  };

  /**
   * Runs, or resumes, the graph for a task, telling its listeners about text and progress as they
   * happen. A takeover carries on the run the record says a stopped replica was working on.
   */
  const execute = async (
    record: A2aTaskRecord,
    message: A2aMessage,
    principal: Principal | undefined,
    takeover = false,
  ): Promise<void> => {
    const task = record.task;
    const controller = new AbortController();
    running.set(task.id, controller);
    let streamed = false;
    const runOptions: ProtocolRunOptions = {
      threadId: task.id,
      signal: controller.signal,
      ...(principal ? { principal } : {}),
      onEvent: (event: GraphEvent) => {
        if (event.namespace) return;
        if (event.type === 'message' && event.chunk.kind !== 'reasoning' && event.chunk.content) {
          const piece = {
            artifactUpdate: {
              taskId: task.id,
              contextId: task.contextId,
              artifact: { artifactId: `${task.id}:answer`, name: 'answer', parts: [{ text: event.chunk.content }] },
              append: streamed,
            },
          };
          publish(task.id, piece);
          pushText(record, piece);
          streamed = true;
        } else if (event.type === 'tool' && event.tool.phase === 'progress') {
          publish(task.id, { statusUpdate: progressUpdate(task, event.tool) });
        }
      },
    };
    // The lease is renewed while the run works. A replica that finds another holding it has lost the
    // task, and stops, so the run is carried on once, by the replica that took it.
    let lost = false;
    const heartbeat = setInterval(
      () => {
        void claimLease(task.id).then(
          (renewed) => {
            if (renewed) {
              record.lease = renewed.lease;
              record.version = renewed.version;
            } else if (!controller.signal.aborted) {
              lost = true;
              controller.abort(new Error(`Task ${task.id} was taken over by another replica`));
            }
          },
          () => undefined,
        );
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    (heartbeat as { unref?: () => void }).unref?.();
    try {
      let result: ProtocolResult;
      if (takeover) {
        // A task submitted to a replica that stopped before starting it starts here.
        if (task.status.state === 'TASK_STATE_SUBMITTED') await changeStatus(record, 'TASK_STATE_WORKING');
        result = await carryOn(record, runOptions);
      } else if (record.interrupts?.length) {
        const answers = Object.fromEntries(
          record.interrupts.map((interrupt) => [interrupt.id, answer(message, interrupt)]),
        );
        record.lease = { owner, expiresAt: leaseUntil() };
        record.run = { kind: 'resume', message, answers, ...(principal ? { principal } : {}) };
        await changeStatus(record, 'TASK_STATE_WORKING');
        record.interrupts = undefined;
        result = await graph.resumeInterruptsWith(task.id, answers, runOptions);
      } else {
        record.lease = { owner, expiresAt: leaseUntil() };
        record.run = { kind: 'invoke', message, ...(principal ? { principal } : {}) };
        await changeStatus(record, 'TASK_STATE_WORKING');
        result = await startRun(record, message, runOptions);
      }
      // A cancel here or on another replica stands, and so does another replica's takeover: the result
      // is not recorded over either.
      const stored = await store.get(task.id);
      if (
        controller.signal.aborted ||
        lost ||
        stored?.task.status.state === 'TASK_STATE_CANCELED' ||
        (stored?.lease && stored.lease.owner !== owner)
      ) {
        return;
      }
      record.lease = undefined;
      record.run = undefined;
      if (stored?.version !== undefined) record.version = stored.version;
      if (result.status === 'awaiting_input' && result.interrupts?.length) {
        record.interrupts = result.interrupts;
        await changeStatus(
          record,
          'TASK_STATE_INPUT_REQUIRED',
          agentMessage(task, result.interrupts.map((item) => item.reason ?? 'Input is required').join('\n'), {
            interrupts: result.interrupts,
          }),
        );
      } else {
        const text = answerOf(result.state);
        const reply = agentMessage(task, text);
        record.history.push(reply);
        const before = (await store.conversation(task.contextId)) ?? [];
        await store.saveConversation(
          task.contextId,
          transcriptOf(result.state, [...before, messageOf('assistant', text)]),
        );
        task.artifacts = [{ artifactId: `${task.id}:answer`, name: 'answer', parts: [{ text }] }];
        if (streamed) {
          const last = {
            artifactUpdate: {
              taskId: task.id,
              contextId: task.contextId,
              artifact: { artifactId: `${task.id}:answer`, name: 'answer', parts: [] },
              append: true,
              lastChunk: true,
            },
          };
          publish(task.id, last);
          pushText(record, last);
        }
        await changeStatus(record, 'TASK_STATE_COMPLETED', reply);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const lease = record.lease;
      const run = record.run;
      record.lease = undefined;
      record.run = undefined;
      try {
        await changeStatus(
          record,
          'TASK_STATE_FAILED',
          agentMessage(task, error instanceof Error ? error.message : String(error)),
        );
      } catch (unrecorded) {
        // The store would not take the failure either: the task is left as it was, with its lease, so
        // the replica that takes it over once the lease lapses carries it on.
        record.lease = lease;
        record.run = run;
        options.onError?.(unrecorded);
      }
    } finally {
      clearInterval(heartbeat);
      running.delete(task.id);
    }
  };

  /** Starts a run from a message: the context's conversation, then the message. */
  const startRun = async (
    record: A2aTaskRecord,
    message: A2aMessage,
    runOptions: ProtocolRunOptions,
  ): Promise<ProtocolResult> => {
    const history = (await store.conversation(record.task.contextId)) ?? [];
    const said = messageOf('user', textOfParts(message.parts));
    const result = await graph.invoke(
      options.input ? options.input(message, history) : { messages: [...history, said] },
      runOptions,
    );
    await store.saveConversation(record.task.contextId, [...history, said]);
    return result;
  };

  /**
   * Carries on the run a stopped replica left: answers its questions again when the graph still waits
   * on them, starts it over when it left no checkpoint, and otherwise continues from its last one.
   */
  const carryOn = async (record: A2aTaskRecord, runOptions: ProtocolRunOptions): Promise<ProtocolResult> => {
    const run = record.run;
    const checkpoint = graph.state ? await graph.state(record.task.id) : undefined;
    if (run?.kind === 'resume' && run.answers && (!checkpoint || checkpoint.status === 'awaiting_input')) {
      return graph.resumeInterruptsWith(record.task.id, run.answers, runOptions);
    }
    if (checkpoint && graph.continueWith) return graph.continueWith(record.task.id, runOptions);
    if (!checkpoint && run?.kind === 'invoke') return startRun(record, run.message, runOptions);
    throw new Error(
      `The replica running task ${record.task.id} stopped, and this agent's graph cannot carry its run on`,
    );
  };

  /**
   * Takes over the working tasks whose lease lapsed, and the tasks submitted to a replica that stopped
   * before starting them, and carries each on.
   */
  const recover = async (recoverOptions: { limit?: number } = {}): Promise<A2aRecoveryReport> => {
    const report: A2aRecoveryReport = { tookOver: [], skipped: 0 };
    const limit = recoverOptions.limit ?? 10;
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - leaseMs).toISOString();
    for (const state of ['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'] as const) {
      for (let offset = 0; report.tookOver.length < limit; offset += 100) {
        const { records } = await store.list({ state, limit: 100, offset });
        for (const candidate of records) {
          if (report.tookOver.length >= limit) break;
          if (running.has(candidate.task.id)) continue;
          // A task without a lease is lapsed once it is stale: one working, written before tasks had
          // leases, or one submitted to a replica that stopped before it started the run.
          const lapsed = candidate.lease ? candidate.lease.expiresAt <= now : candidate.updatedAt <= stale;
          if (!lapsed) continue;
          const record = await claimLease(candidate.task.id);
          if (!record) {
            report.skipped += 1;
            continue;
          }
          report.tookOver.push(record.task.id);
          const message = record.run?.message ?? record.history.at(-1) ?? ({ parts: [] } as unknown as A2aMessage);
          void execute(record, message, record.run?.principal, true).catch((error: unknown) =>
            options.onError?.(error),
          );
        }
        if (records.length < 100) break;
      }
    }
    return report;
  };

  const timer =
    options.recoverEveryMs === undefined
      ? undefined
      : setInterval(() => {
          void recover().catch((error: unknown) => options.onError?.(error));
        }, options.recoverEveryMs);
  (timer as { unref?: () => void } | undefined)?.unref?.();

  /**
   * The task a message starts, or the paused one it answers. A new task is written with the run it
   * asks for, so a replica that stops before starting it leaves it for another to start.
   */
  const taskFor = async (
    message: A2aMessage,
    principal: Principal | undefined,
  ): Promise<A2aTaskRecord | { error: number; message: string }> => {
    if (message.taskId) {
      const existing = await store.get(message.taskId);
      if (!existing) return { error: A2A_ERRORS.taskNotFound, message: `Task ${message.taskId} was not found` };
      if (existing.task.status.state !== 'TASK_STATE_INPUT_REQUIRED') {
        return { error: A2A_ERRORS.unsupportedOperation, message: `Task ${message.taskId} is not waiting for input` };
      }
      existing.history.push(message);
      return existing;
    }
    const contextId = message.contextId ?? protocolId('context');
    const task: A2aTask = {
      id: protocolId('task'),
      contextId,
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
    };
    const said = { ...message, contextId, taskId: task.id };
    const record: A2aTaskRecord = {
      task,
      history: [said],
      run: { kind: 'invoke', message: said, ...(principal ? { principal } : {}) },
      updatedAt: new Date().toISOString(),
    };
    await store.put(record);
    return record;
  };

  /** A stream of a task's events: the task, then each event until it finishes or waits. */
  const follow = (
    record: A2aTaskRecord,
    start: (() => Promise<void>) | undefined,
    signal: AbortSignal | undefined,
  ): ReadableStream<A2aStreamEvent> => {
    const taskId = record.task.id;
    let open = true;
    let stop = () => {};
    return new ReadableStream<A2aStreamEvent>({
      start: async (controller) => {
        const send = (event: A2aStreamEvent) => {
          if (open) controller.enqueue(event);
        };
        const close = () => {
          if (!open) return;
          open = false;
          stop();
          controller.close();
        };
        send({ task: view(record) });
        stop = listen(taskId, (event) => {
          send(event);
          if ('statusUpdate' in event && settled(event.statusUpdate.status.state)) close();
        });
        signal?.addEventListener('abort', close, { once: true });
        if (start) {
          await start();
          close();
        } else if (!running.has(taskId)) {
          // Another replica runs it: read the task until it finishes or waits, and report each change.
          let last = record.task.status.timestamp;
          while (open) {
            await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1_000));
            const current = await store.get(taskId);
            if (!current || !open) break;
            if (current.task.status.timestamp !== last) {
              last = current.task.status.timestamp;
              send({
                statusUpdate: { taskId, contextId: current.task.contextId, status: current.task.status },
              });
            }
            if (settled(current.task.status.state)) break;
          }
          close();
        }
      },
      // The caller went away: stop following, and leave the task running.
      cancel: () => {
        open = false;
        stop();
      },
    });
  };

  /** A task's webhook config, from any shape a caller sends: protocol 1.0's, flat, or the drafts', nested. */
  const pushConfigOf = (params: Record<string, unknown>): A2aPushNotificationConfig | undefined => {
    const nested = (params.pushNotificationConfig ?? params.config) as A2aPushNotificationConfig | undefined;
    const config =
      nested ?? (typeof params.url === 'string' ? (params as unknown as A2aPushNotificationConfig) : undefined);
    return config && typeof config.url === 'string' ? config : undefined;
  };

  /** Adds a webhook to a task, after checking where it points. */
  const addPush = (record: A2aTaskRecord, config: A2aPushNotificationConfig): A2aPushNotificationConfig => {
    const refusal = pushRefusal(config.url, options.pushNotifications?.allowPrivateNetworks === true);
    if (refusal) throw Object.assign(new Error(refusal), { code: -32602 });
    const authentication = config.authentication?.scheme ? config.authentication : undefined;
    const kept: A2aPushNotificationConfig = {
      // A config sent over gRPC carries an empty id when it has none.
      id: config.id || protocolId('push'),
      url: config.url,
      ...(config.token ? { token: config.token } : {}),
      ...(authentication
        ? {
            authentication: {
              scheme: authentication.scheme,
              ...(authentication.credentials ? { credentials: authentication.credentials } : {}),
            },
          }
        : {}),
    };
    record.push = [...(record.push ?? []).filter((item) => item.id !== kept.id), kept];
    return kept;
  };

  /**
   * A push config as answered: flat, as protocol 1.0 has it, and over JSON-RPC also nested, as the
   * drafts had it, so a client written against either reads it.
   */
  const pushAnswer = (taskId: string, config: A2aPushNotificationConfig, binding: A2aBinding) =>
    binding === 'JSONRPC' ? { taskId, ...config, pushNotificationConfig: config } : { taskId, ...config };

  const fail = (code: number, message: string): A2aCallOutcome => ({ error: { code, message } });

  /** Runs one method of the protocol, for whichever binding carried it. */
  const call = async (
    method: string,
    params: Record<string, unknown>,
    context: A2aCallContext = {},
  ): Promise<A2aCallOutcome> => {
    const principal = context.principal;
    const binding = context.binding ?? 'JSONRPC';
    const pushOn = Boolean(options.pushNotifications);
    try {
      switch (method) {
        case 'SendMessage':
        case 'SendStreamingMessage': {
          const message = params.message as A2aMessage | undefined;
          if (!message || !Array.isArray(message.parts)) return fail(-32602, 'params.message with parts is required');
          const configuration = (params.configuration ?? {}) as {
            returnImmediately?: boolean;
            historyLength?: number;
            pushNotificationConfig?: A2aPushNotificationConfig;
            taskPushNotificationConfig?: A2aPushNotificationConfig;
          };
          const pushConfig = configuration.taskPushNotificationConfig ?? configuration.pushNotificationConfig;
          if (pushConfig && !pushOn) {
            return fail(A2A_ERRORS.pushNotificationNotSupported, 'This agent does not push notifications');
          }
          const record = await taskFor(message, principal);
          if ('error' in record) return fail(record.error, record.message);
          if (pushConfig) {
            addPush(record, pushConfig);
            await store.put(record);
          }
          if (method === 'SendMessage') {
            const run = execute(record, message, principal);
            if (configuration.returnImmediately) void run.catch((error: unknown) => options.onError?.(error));
            else await run;
            return { result: { task: view(record, configuration.historyLength) } };
          }
          return { events: follow(record, () => execute(record, message, principal), context.signal) };
        }
        case 'GetTask': {
          const record = await store.get(String(params.id ?? ''));
          if (!record) return fail(A2A_ERRORS.taskNotFound, `Task ${String(params.id)} was not found`);
          return { result: view(record, typeof params.historyLength === 'number' ? params.historyLength : undefined) };
        }
        case 'ListTasks': {
          const pageSize = Math.min(100, Math.max(1, Number(params.pageSize ?? 50) || 50));
          const offset = Math.max(0, Number.parseInt(String(params.pageToken ?? '0'), 10) || 0);
          // An unset filter arrives as the protocol's unspecified state, or, from the reference SDK, as
          // UNRECOGNIZED; either filters nothing. Any other state this agent does not know is refused.
          const raw = typeof params.status === 'string' ? params.status : '';
          const status = raw === 'UNRECOGNIZED' ? '' : taskStateOf(raw);
          const filtered = status !== '' && status !== 'TASK_STATE_UNSPECIFIED';
          if (filtered && !TASK_STATES.has(status as A2aTaskState)) return fail(-32602, `"${raw}" is not a task state`);
          const listed = await store.list({
            ...(typeof params.contextId === 'string' && params.contextId !== '' ? { contextId: params.contextId } : {}),
            ...(filtered ? { state: status as A2aTaskState } : {}),
            limit: pageSize,
            offset,
          });
          const historyLength = typeof params.historyLength === 'number' ? params.historyLength : undefined;
          const after = typeof params.statusTimestampAfter === 'string' ? params.statusTimestampAfter : undefined;
          const more =
            listed.total === undefined ? listed.records.length === pageSize : offset + pageSize < listed.total;
          return {
            result: {
              tasks: listed.records
                .filter((record) => !after || (record.task.status.timestamp ?? '') >= after)
                .map((record) => view(record, historyLength))
                .map(({ artifacts, ...task }) =>
                  params.includeArtifacts === false ? task : { ...task, ...(artifacts ? { artifacts } : {}) },
                ),
              nextPageToken: more ? String(offset + pageSize) : '',
              pageSize,
              ...(listed.total === undefined ? {} : { totalSize: listed.total }),
            },
          };
        }
        case 'SubscribeToTask': {
          const record = await store.get(String(params.id ?? ''));
          if (!record) return fail(A2A_ERRORS.taskNotFound, `Task ${String(params.id)} was not found`);
          if (TERMINAL.has(record.task.status.state)) {
            return fail(A2A_ERRORS.unsupportedOperation, `Task ${record.task.id} has already finished`);
          }
          if (record.task.status.state === 'TASK_STATE_INPUT_REQUIRED') {
            return { events: follow(record, async () => undefined, context.signal) };
          }
          return { events: follow(record, undefined, context.signal) };
        }
        case 'CancelTask': {
          const record = await store.get(String(params.id ?? ''));
          if (!record) return fail(A2A_ERRORS.taskNotFound, `Task ${String(params.id)} was not found`);
          if (TERMINAL.has(record.task.status.state)) {
            return fail(A2A_ERRORS.taskNotCancelable, `Task ${record.task.id} has already finished`);
          }
          running.get(record.task.id)?.abort(new Error('Cancelled by the calling agent'));
          record.lease = undefined;
          record.run = undefined;
          await changeStatus(record, 'TASK_STATE_CANCELED');
          return { result: view(record) };
        }
        case 'CreateTaskPushNotificationConfig':
        case 'GetTaskPushNotificationConfig':
        case 'ListTaskPushNotificationConfig':
        case 'ListTaskPushNotificationConfigs':
        case 'DeleteTaskPushNotificationConfig': {
          if (!pushOn) return fail(A2A_ERRORS.pushNotificationNotSupported, 'This agent does not push notifications');
          const taskId = String(params.taskId ?? params.id ?? '');
          const record = await store.get(taskId);
          if (!record) return fail(A2A_ERRORS.taskNotFound, `Task ${taskId} was not found`);
          if (method === 'CreateTaskPushNotificationConfig') {
            const config = pushConfigOf(params);
            if (!config) return fail(-32602, 'A push notification config with a url is required');
            const kept = addPush(record, config);
            await store.put(record);
            return { result: pushAnswer(taskId, kept, binding) };
          }
          if (method === 'ListTaskPushNotificationConfigs') {
            return {
              result: { configs: (record.push ?? []).map((config) => ({ taskId, ...config })), nextPageToken: '' },
            };
          }
          if (method === 'ListTaskPushNotificationConfig') {
            return { result: (record.push ?? []).map((config) => ({ taskId, pushNotificationConfig: config })) };
          }
          // Protocol 1.0 names the config `id` beside `taskId`; the drafts, `pushNotificationConfigId`.
          const configId = String(
            params.pushNotificationConfigId ??
              params.configId ??
              (params.taskId !== undefined ? (params.id ?? '') : ''),
          );
          const found = record.push?.find((item) => item.id === configId);
          if (!found) return fail(-32602, `Task ${taskId} has no push config ${configId}`);
          if (method === 'GetTaskPushNotificationConfig') return { result: pushAnswer(taskId, found, binding) };
          record.push = record.push?.filter((item) => item.id !== configId);
          await store.put(record);
          return { result: binding === 'JSONRPC' ? null : {} };
        }
        case 'GetExtendedAgentCard': {
          if (!options.extendedCard)
            return fail(A2A_ERRORS.extendedCardNotConfigured, 'This agent has no extended card');
          if (!principal) {
            return fail(A2A_ERRORS.extendedCardNotConfigured, 'The extended card needs an authenticated caller');
          }
          return { result: { ...card, ...(await options.extendedCard(principal)) } };
        }
        default:
          return fail(-32601, `Method ${method} is not supported`);
      }
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return fail(typeof code === 'number' ? code : -32603, error instanceof Error ? error.message : String(error));
    }
  };

  const bindings = new Set(options.bindings ?? ['JSONRPC', 'HTTP+JSON']);
  /** Where the handler is mounted: its routes are under the card URL's path. */
  const base = new URL(options.card.url).pathname.replace(/\/+$/, '');
  const versionRefused = (request: Request) => {
    const version = request.headers.get('a2a-version');
    return version && !version.startsWith('1.')
      ? `This agent speaks A2A ${A2A_PROTOCOL_VERSION}, not ${version}`
      : undefined;
  };

  /** The JSON-RPC binding: one POST per call, a stream as Server-Sent Events of JSON-RPC results. */
  const jsonRpc = async (request: Request): Promise<Response> => {
    let rpc: { jsonrpc?: string; id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      rpc = (await request.json()) as typeof rpc;
    } catch {
      return rpcError(null, -32700, 'The body is not JSON');
    }
    const id = rpc.id ?? null;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')
      return rpcError(id, -32600, 'Not a JSON-RPC 2.0 request');
    const refused = versionRefused(request);
    if (refused) return rpcError(id, A2A_ERRORS.versionNotSupported, refused);
    const outcome = await call(rpc.method, rpc.params ?? {}, {
      principal: await options.principal?.(request),
      signal: request.signal,
      binding: 'JSONRPC',
    });
    if ('events' in outcome)
      return serverSent(outcome.events, (result) => JSON.stringify({ jsonrpc: '2.0', id, result }));
    if ('error' in outcome) return rpcError(id, outcome.error.code, outcome.error.message);
    return rpcResult(id, outcome.result);
  };

  /**
   * The HTTP+JSON binding: a route per call under the card's URL, its params in the path, the query,
   * and the body, a stream as Server-Sent Events of each event, an error as AIP-193's JSON. `undefined`
   * for a request that is not one of its routes.
   */
  const httpJson = async (request: Request, route: string): Promise<Response | undefined> => {
    const verb = request.method;
    const query = new URL(request.url).searchParams;
    const number = (name: string) => (query.has(name) ? Number(query.get(name)) : undefined);
    const id = (value: string | undefined) => decodeURIComponent(value ?? '');
    const cancel = /^\/tasks\/([^/:]+):cancel$/.exec(route);
    const subscribe = /^\/tasks\/([^/:]+):subscribe$/.exec(route);
    const configs = /^\/tasks\/([^/:]+)\/pushNotificationConfigs$/.exec(route);
    const config = /^\/tasks\/([^/:]+)\/pushNotificationConfigs\/([^/]+)$/.exec(route);
    const task = /^\/tasks\/([^/:]+)$/.exec(route);
    let method: string;
    let params: Record<string, unknown> = {};
    let body = false;
    if (verb === 'POST' && route === '/message:send') [method, body] = ['SendMessage', true];
    else if (verb === 'POST' && route === '/message:stream') [method, body] = ['SendStreamingMessage', true];
    else if (verb === 'GET' && route === '/tasks') {
      method = 'ListTasks';
      params = {
        ...(query.has('contextId') ? { contextId: query.get('contextId') } : {}),
        ...(query.has('status') ? { status: query.get('status') } : {}),
        ...(query.has('pageSize') ? { pageSize: number('pageSize') } : {}),
        ...(query.has('pageToken') ? { pageToken: query.get('pageToken') } : {}),
        ...(query.has('historyLength') ? { historyLength: number('historyLength') } : {}),
        ...(query.has('statusTimestampAfter') ? { statusTimestampAfter: query.get('statusTimestampAfter') } : {}),
        ...(query.has('includeArtifacts') ? { includeArtifacts: query.get('includeArtifacts') === 'true' } : {}),
      };
    } else if (verb === 'GET' && route === '/extendedAgentCard') method = 'GetExtendedAgentCard';
    else if (cancel && verb === 'POST') [method, body, params] = ['CancelTask', true, { id: id(cancel[1]) }];
    else if (subscribe && (verb === 'POST' || verb === 'GET'))
      [method, params] = ['SubscribeToTask', { id: id(subscribe[1]) }];
    else if (configs && verb === 'POST') {
      [method, body, params] = ['CreateTaskPushNotificationConfig', true, { taskId: id(configs[1]) }];
    } else if (configs && verb === 'GET')
      [method, params] = ['ListTaskPushNotificationConfigs', { taskId: id(configs[1]) }];
    else if (config && (verb === 'GET' || verb === 'DELETE')) {
      method = verb === 'GET' ? 'GetTaskPushNotificationConfig' : 'DeleteTaskPushNotificationConfig';
      params = { taskId: id(config[1]), id: id(config[2]) };
    } else if (task && verb === 'GET') {
      method = 'GetTask';
      params = { id: id(task[1]), ...(query.has('historyLength') ? { historyLength: number('historyLength') } : {}) };
    } else return undefined;

    const refused = versionRefused(request);
    if (refused) return restError(A2A_ERRORS.versionNotSupported, refused);
    if (body) {
      const text = await request.text();
      try {
        // The path's ids stand over the body's.
        params = { ...(text ? (JSON.parse(text) as Record<string, unknown>) : {}), ...params };
      } catch {
        return restError(-32700, 'The body is not JSON');
      }
    }
    const outcome = await call(method, params, {
      principal: await options.principal?.(request),
      signal: request.signal,
      binding: 'HTTP+JSON',
    });
    if ('events' in outcome) return serverSent(outcome.events, (event) => JSON.stringify(event));
    if ('error' in outcome) return restError(outcome.error.code, outcome.error.message);
    return Response.json(outcome.result ?? {});
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (url.pathname.endsWith('/.well-known/agent-card.json') || url.pathname.endsWith('/agent-card.json')) {
        return Response.json(card);
      }
    }
    // Under the card's URL, a route of the HTTP+JSON binding; the URL itself, or any other path a
    // POST reaches, JSON-RPC, as it always was.
    const route = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : undefined;
    if (bindings.has('HTTP+JSON') && route && route !== '/') {
      const answered = await httpJson(request, route);
      if (answered) return answered;
    }
    if (request.method === 'GET') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST')
      return new Response('A2A calls are POSTed', { status: 405, headers: { allow: 'GET, POST' } });
    if (!bindings.has('JSONRPC')) return new Response('Not found', { status: 404 });
    return jsonRpc(request);
  };
  return Object.assign(handle, {
    owner,
    recover,
    call,
    card,
    authenticate: async (request: Request) => options.principal?.(request),
    close: () => {
      if (timer) clearInterval(timer);
    },
  });
}

/** A task as returned, with as much of its history as was asked for. */
function view(record: A2aTaskRecord, historyLength?: number): A2aTask {
  return {
    ...record.task,
    ...(historyLength === undefined || historyLength <= 0 ? {} : { history: record.history.slice(-historyLength) }),
  };
}

/** A tool's progress, as the working status of its task: what is happening in text, and as data. */
function progressUpdate(task: A2aTask, tool: GraphToolEvent) {
  return {
    taskId: task.id,
    contextId: task.contextId,
    status: {
      state: 'TASK_STATE_WORKING' as const,
      message: agentMessage(task, `${tool.name}: ${asText(tool.progress)}`, {
        toolCallId: tool.id,
        tool: tool.name,
        progress: tool.progress,
      }),
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Why a webhook URL is refused, or `undefined` when it may be used. Unless private networks are
 * allowed, it must be `https` to a host that is not a loopback, private, or link-local address or name.
 * A name is checked as written; a client passed as `fetch` can check the addresses it resolves to.
 */
function pushRefusal(raw: string, allowPrivate: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'A push notification URL must be a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'A push notification URL must be http or https';
  if (allowPrivate) return undefined;
  if (url.protocol !== 'https:') return 'A push notification URL must be https';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateName =
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)?.slice(1).map(Number);
  const privateV4 =
    v4 !== undefined &&
    (v4[0] === 10 ||
      v4[0] === 127 ||
      v4[0] === 0 ||
      (v4[0] === 169 && v4[1] === 254) ||
      (v4[0] === 172 && (v4[1] ?? 0) >= 16 && (v4[1] ?? 0) <= 31) ||
      (v4[0] === 192 && v4[1] === 168) ||
      (v4[0] === 100 && (v4[1] ?? 0) >= 64 && (v4[1] ?? 0) <= 127));
  const privateV6 =
    host.includes(':') &&
    (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'));
  if (privateName || privateV4 || privateV6) {
    return `A push notification URL may not point at a private address: ${url.hostname}`;
  }
  return undefined;
}

/** Posts one update to a webhook: signed when there is a secret, with the caller's token. */
async function deliver(config: A2aPushNotificationConfig, body: string, push: A2aPushOptions): Promise<void> {
  const fetcher = push.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.token) headers['x-a2a-notification-token'] = config.token;
  if (config.authentication?.scheme) {
    headers.authorization = `${config.authentication.scheme} ${config.authentication.credentials ?? ''}`.trim();
  }
  if (push.secret) headers['x-nexus-signature'] = await signature(body, push.secret);
  const response = await fetcher(config.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(push.timeoutMs ?? 5_000),
    redirect: 'manual',
  });
  if (!response.ok) throw new Error(`A push notification to ${config.url} answered ${response.status}`);
}

/** The operation webhooks' signature, `t=<seconds>,v1=<hex HMAC-SHA256 of "<seconds>.<body>">`, through Web Crypto. */
async function signature(body: string, secret: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(`${seconds}.${body}`)));
  return `t=${seconds},v1=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
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

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as string);
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

/** An error as the HTTP+JSON binding carries it: AIP-193's JSON, with A2A's `ErrorInfo`. */
function restError(code: number, message: string): Response {
  const status = a2aErrorStatus(code);
  return Response.json(
    {
      error: {
        code: status.httpStatus,
        status: status.grpcStatus,
        message,
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: status.reason, domain: 'a2a-protocol.org' },
        ],
      },
    },
    { status: status.httpStatus },
  );
}

/** A stream of events as Server-Sent Events, each framed by `frame`; an error mid-stream as `error`. */
function serverSent(events: ReadableStream<A2aStreamEvent>, frame: (event: A2aStreamEvent) => string): Response {
  const encoder = new TextEncoder();
  const reader = events.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(`data: ${frame(value)}\n\n`));
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

/** A task state as a query names it: `TASK_STATE_WORKING`, or `working`, or `input-required`. */
function taskStateOf(value: string): string {
  if (value === '' || value.startsWith('TASK_STATE_')) return value;
  return `TASK_STATE_${value.replace(/[-\s]/g, '_').toUpperCase()}`;
}

// ── The client ──────────────────────────────────────────────────────

/** Options for `a2aClient()`. */
export interface A2aClientOptions {
  /** The agent: its card's URL, or its endpoint for the binding, whose origin serves the card. */
  url: string;
  /** Replaces the global `fetch`, for authentication, a proxy, or tests. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request, such as an authorization header. */
  headers?: Record<string, string>;
  /**
   * The binding to call the agent over: `JSONRPC`, the default, or `HTTP+JSON`. Given the card's URL,
   * the client calls the interface the card lists for it. gRPC has its own client, `a2aGrpcClient()`,
   * on `nexus-ai-pro/protocols/a2a/grpc`.
   */
  binding?: 'JSONRPC' | 'HTTP+JSON';
}

/** What to send: text, and optionally data, a conversation, or the paused task it answers. */
export interface A2aSendOptions {
  /** The conversation to continue. */
  contextId?: string;
  /** The paused task this message answers. */
  taskId?: string;
  /** Structured data sent beside the text, such as `{ approved: true }`. */
  data?: unknown;
  /** A webhook for this task's updates, when the agent pushes them. */
  push?: A2aPushNotificationConfig;
  /** Returns the task while it runs, instead of when it is done. */
  returnImmediately?: boolean;
  /** Cancels the request. */
  signal?: AbortSignal;
}

/** Which tasks `A2aClient.listTasks()` asks for. */
export interface A2aListTasksOptions {
  /** Only this conversation's. */
  contextId?: string;
  /** Only those in this state. */
  status?: A2aTaskState;
  /** Tasks per page, up to 100. Defaults to 50. */
  pageSize?: number;
  /** The `nextPageToken` of the page before. */
  pageToken?: string;
  /** Messages of each task's history to include. */
  historyLength?: number;
}

/** A page of tasks. */
export interface A2aTaskPage {
  /** The tasks. */
  tasks: A2aTask[];
  /** The token for the next page, or empty when this is the last. */
  nextPageToken: string;
  /** The page size used. */
  pageSize: number;
  /** How many tasks match, when the agent's store counts them. */
  totalSize?: number;
}

/** A client for one A2A agent. */
export interface A2aClient {
  /** The agent's card, fetched once. */
  card(): Promise<A2aAgentCard>;
  /** The card for an authenticated caller, as `GetExtendedAgentCard` returns it. */
  extendedCard(): Promise<A2aAgentCard>;
  /** Sends a message and waits for the task it starts or continues. */
  send(text: string, options?: A2aSendOptions): Promise<A2aTask>;
  /** Sends a message and reads the task's events as they arrive. */
  stream(text: string, options?: A2aSendOptions): AsyncGenerator<A2aStreamEvent>;
  /** Reads a task. */
  getTask(taskId: string, historyLength?: number): Promise<A2aTask>;
  /** Lists tasks, a page at a time. */
  listTasks(options?: A2aListTasksOptions): Promise<A2aTaskPage>;
  /** Follows a task that is still running, from now until it finishes or waits. */
  subscribe(taskId: string, options?: { signal?: AbortSignal }): AsyncGenerator<A2aStreamEvent>;
  /** Cancels a task. */
  cancel(taskId: string): Promise<A2aTask>;
  /** Adds a webhook for a task's updates. */
  setPushNotification(taskId: string, config: A2aPushNotificationConfig): Promise<A2aPushNotificationConfig>;
  /** A task's webhooks. */
  listPushNotifications(taskId: string): Promise<A2aPushNotificationConfig[]>;
  /** Removes one of a task's webhooks. */
  deletePushNotification(taskId: string, configId: string): Promise<void>;
}

/** A client for an A2A agent, by its card or endpoint URL. */
export function a2aClient(options: A2aClientOptions): A2aClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const binding = options.binding ?? 'JSONRPC';
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
      ? ((await card()).supportedInterfaces.find((item) => item.protocolBinding === binding)?.url ?? options.url)
      : options.url;
  const headers = { 'content-type': 'application/json', 'a2a-version': A2A_PROTOCOL_VERSION, ...options.headers };

  let ids = 0;
  /** A JSON-RPC call, POSTed to the endpoint. */
  const rpc = async (method: string, params: unknown, signal?: AbortSignal) =>
    fetcher(await endpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method, params }),
      ...(signal ? { signal } : {}),
    });
  /** An HTTP+JSON call: its route under the endpoint, a body for a POST. */
  const route = async (verb: string, path: string, body?: unknown, signal?: AbortSignal) =>
    fetcher(`${(await endpoint()).replace(/\/+$/, '')}${path}`, {
      method: verb,
      headers: body === undefined ? { ...headers, 'content-type': 'application/json' } : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  /** The HTTP+JSON binding's error, AIP-193's JSON, as an `A2aError` with the protocol's code. */
  const restFailure = async (response: Response): Promise<A2aError> => {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; details?: Array<{ reason?: string }> };
    };
    const reason = body.error?.details?.find((detail) => detail.reason)?.reason;
    return new A2aError(
      a2aErrorCode(reason, response.status >= 500 ? -32603 : -32602),
      body.error?.message ?? `The agent answered ${response.status}`,
      body.error,
    );
  };
  const call = async <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    if (binding === 'HTTP+JSON') {
      const [verb, path, body] = restCall(method, params);
      const response = await route(verb, path, body, signal);
      if (!response.ok) throw await restFailure(response);
      return (response.status === 204 ? {} : await response.json()) as T;
    }
    const response = await rpc(method, params, signal);
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new A2aError(body.error.code, body.error.message, body.error.data);
    return body.result as T;
  };
  /** Reads a stream of events sent as Server-Sent Events: JSON-RPC results, or the events themselves. */
  async function* events(response: Response): AsyncGenerator<A2aStreamEvent> {
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      if (binding === 'HTTP+JSON') throw await restFailure(response);
      const body = (await response.json()) as { error?: { code: number; message: string } };
      throw new A2aError(body.error?.code ?? response.status, body.error?.message ?? 'The agent did not stream');
    }
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
          const parsed = JSON.parse(data) as Record<string, unknown> & {
            result?: A2aStreamEvent;
            error?: { code?: number; message: string; details?: Array<{ reason?: string }> };
          };
          if (parsed.error) {
            const reason = parsed.error.details?.find((detail) => detail.reason)?.reason;
            throw new A2aError(parsed.error.code ?? a2aErrorCode(reason), parsed.error.message);
          }
          if (binding === 'HTTP+JSON') yield parsed as unknown as A2aStreamEvent;
          else if (parsed.result) yield parsed.result;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }
  const stream = async (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    if (binding === 'HTTP+JSON') {
      const [verb, path, body] = restCall(method, params);
      return route(verb, path, body, signal);
    }
    return rpc(method, params, signal);
  };
  const message = (text: string, send: A2aSendOptions): A2aMessage => ({
    messageId: protocolId('message'),
    role: 'ROLE_USER',
    parts: [{ text }, ...(send.data === undefined ? [] : [{ data: send.data }])],
    ...(send.contextId ? { contextId: send.contextId } : {}),
    ...(send.taskId ? { taskId: send.taskId } : {}),
  });
  // Protocol 1.0 names the webhook `taskPushNotificationConfig`; JSON-RPC agents written to the drafts
  // read `pushNotificationConfig`, so JSON-RPC sends both.
  const configuration = (send: A2aSendOptions) => ({
    returnImmediately: send.returnImmediately === true,
    ...(send.push
      ? binding === 'JSONRPC'
        ? { taskPushNotificationConfig: send.push, pushNotificationConfig: send.push }
        : { taskPushNotificationConfig: send.push }
      : {}),
  });
  /** A push config as an agent answers it: flat, as protocol 1.0 has it, or nested, as the drafts did. */
  const pushConfigOf = (answer: Record<string, unknown>): A2aPushNotificationConfig => {
    const nested = answer.pushNotificationConfig as A2aPushNotificationConfig | undefined;
    if (nested) return nested;
    const { taskId: _taskId, tenant: _tenant, ...config } = answer;
    return config as unknown as A2aPushNotificationConfig;
  };

  return {
    card,
    extendedCard: () => call<A2aAgentCard>('GetExtendedAgentCard', {}),
    async send(text, send = {}) {
      const result = await call<{ task?: A2aTask; message?: A2aMessage }>(
        'SendMessage',
        { message: message(text, send), configuration: configuration(send) },
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
      const response = await stream(
        'SendStreamingMessage',
        { message: message(text, send), ...(send.push ? { configuration: configuration(send) } : {}) },
        send.signal,
      );
      yield* events(response);
    },
    getTask: (taskId, historyLength) =>
      call<A2aTask>('GetTask', { id: taskId, ...(historyLength ? { historyLength } : {}) }),
    listTasks: (list = {}) => call<A2aTaskPage>('ListTasks', { ...list }),
    async *subscribe(taskId, subscribe = {}) {
      yield* events(await stream('SubscribeToTask', { id: taskId }, subscribe.signal));
    },
    cancel: (taskId) => call<A2aTask>('CancelTask', { id: taskId }),
    async setPushNotification(taskId, config) {
      const answer = await call<Record<string, unknown>>(
        'CreateTaskPushNotificationConfig',
        binding === 'JSONRPC' ? { taskId, pushNotificationConfig: config } : { ...config, taskId },
      );
      return pushConfigOf(answer);
    },
    async listPushNotifications(taskId) {
      if (binding === 'JSONRPC') {
        const result = await call<Array<{ pushNotificationConfig: A2aPushNotificationConfig }>>(
          'ListTaskPushNotificationConfig',
          { taskId },
        );
        return result.map((item) => item.pushNotificationConfig);
      }
      const result = await call<{ configs?: Array<Record<string, unknown>> }>('ListTaskPushNotificationConfigs', {
        taskId,
      });
      return (result.configs ?? []).map(pushConfigOf);
    },
    async deletePushNotification(taskId, configId) {
      await call(
        'DeleteTaskPushNotificationConfig',
        binding === 'JSONRPC' ? { taskId, pushNotificationConfigId: configId } : { taskId, id: configId },
      );
    },
  };
}

/** A call of the HTTP+JSON binding: its verb, its route with its query, and its body for a POST. */
function restCall(method: string, params: Record<string, unknown>): [string, string, unknown?] {
  const path = (value: unknown) => encodeURIComponent(String(value ?? ''));
  const query = (names: readonly string[]) => {
    const search = new URLSearchParams();
    for (const name of names) {
      const value = params[name];
      if (value !== undefined && value !== '') search.set(name, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };
  switch (method) {
    case 'SendMessage':
      return ['POST', '/message:send', params];
    case 'SendStreamingMessage':
      return ['POST', '/message:stream', params];
    case 'GetTask':
      return ['GET', `/tasks/${path(params.id)}${query(['historyLength'])}`];
    case 'ListTasks':
      return ['GET', `/tasks${query(['contextId', 'status', 'pageSize', 'pageToken', 'historyLength'])}`];
    case 'CancelTask':
      return ['POST', `/tasks/${path(params.id)}:cancel`, {}];
    case 'SubscribeToTask':
      return ['POST', `/tasks/${path(params.id)}:subscribe`, {}];
    case 'CreateTaskPushNotificationConfig':
      return ['POST', `/tasks/${path(params.taskId)}/pushNotificationConfigs`, params];
    case 'ListTaskPushNotificationConfigs':
      return ['GET', `/tasks/${path(params.taskId)}/pushNotificationConfigs`];
    case 'GetTaskPushNotificationConfig':
      return ['GET', `/tasks/${path(params.taskId)}/pushNotificationConfigs/${path(params.id)}`];
    case 'DeleteTaskPushNotificationConfig':
      return ['DELETE', `/tasks/${path(params.taskId)}/pushNotificationConfigs/${path(params.id)}`];
    case 'GetExtendedAgentCard':
      return ['GET', '/extendedAgentCard'];
    default:
      throw new A2aError(-32601, `Method ${method} has no HTTP+JSON route`);
  }
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
