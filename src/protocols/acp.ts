/**
 * ACP, the Agent Client Protocol: a Nexus agent inside an editor. The editor starts the agent as a
 * subprocess and the two speak JSON-RPC 2.0, one message per line, over stdin and stdout.
 *
 * Each editor session is a conversation. While a prompt runs, the editor sees:
 * - the agent's text as it streams;
 * - each tool call, with its kind, the file it touches, its progress, and its result or diff;
 * - the plan, as `write_todos` records it.
 *
 * A tool call that needs approval asks the editor, which shows the person allow and reject choices.
 * A choice to always allow or always reject is kept for the rest of the session.
 *
 * Sessions live in an `AcpSessionStore`, so an editor reopens one with `session/load` after the agent
 * restarts, and a turn the agent was in the middle of is carried on there. A prompt may carry images
 * and audio. An `AcpEditorBridge`, such as `acpEditor()` from
 * `nexus-ai-pro/protocols/acp/editor`, gives the agent the editor's files, terminal, and MCP servers.
 */
import type { GraphEvent } from '../types/graph.js';
import type { ContentPart, Message } from '../types/messages.js';
import type { Principal } from '../types/principal.js';
import type { Store } from '../types/store.js';
import {
  answerOf,
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
export const ACP_PROTOCOL_VERSION = 1;

/** What a tool call does, so the editor can show it: ACP's tool kinds. */
export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

/** Why a prompt's turn ended. */
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** One block of a prompt: text, an image, audio, a file the editor embedded, or a link to one. */
export interface AcpContentBlock {
  /** `text`, `image`, `audio`, `resource`, `resource_link`, or a kind this agent does not read. */
  type: string;
  /** A text block's text. */
  text?: string;
  /** An image or audio block's bytes, as base64. */
  data?: string;
  /** An image or audio block's media type, such as `image/png` or `audio/wav`. */
  mimeType?: string;
  /** A link's URI. */
  uri?: string;
  /** A link's name. */
  name?: string;
  /** An embedded file. */
  resource?: { uri: string; text?: string; mimeType?: string };
}

/** What the agent tells the editor during a turn: ACP's `session/update`. */
export type AcpSessionUpdate = { sessionUpdate: string } & Record<string, unknown>;

/** An editor session, as `input` sees it. */
export interface AcpSessionInfo {
  /** Its id, which is also the graph's thread. */
  id: string;
  /** The directory the editor opened the session in. */
  cwd: string;
  /** The MCP servers the editor offered. */
  mcpServers: unknown[];
}

/** Where the agent reads and writes: `process.stdin` and `process.stdout`, or any pair like them. */
export interface AcpStreams {
  /** What the editor writes. */
  input: AsyncIterable<Uint8Array | string>;
  /** Where the agent writes. */
  output: { write(chunk: string): unknown };
}

/** Options for `serveAcp()`. */
export interface AcpOptions {
  /** The agent's name and version, as the editor shows them. */
  agentInfo?: { name: string; version: string; title?: string };
  /**
   * The graph input for a prompt. Defaults to `{ messages }`: the session's conversation and the
   * prompt, which is what an agent from `createAgent()` takes.
   */
  input?: (prompt: string, session: AcpSessionInfo, history: Message[], blocks: AcpContentBlock[]) => unknown;
  /**
   * The answer the next prompt gives a question that is not a tool approval. Such a question is
   * asked as the agent's message, and the turn ends. Defaults to the prompt's text.
   */
  answer?: (prompt: string, interrupt: ProtocolInterrupt) => unknown;
  /** What a tool does, for the editor. Defaults to a guess from its name. */
  kind?: (name: string, args: unknown) => AcpToolKind;
  /** Who the agent acts for: the person at the editor. */
  principal?: Principal;
  /**
   * Where sessions are kept. Defaults to memory; `storeAcpSessions()` keeps them in a long-term store,
   * so an editor reopens a session with `session/load` after the agent restarts. A question the last
   * turn asked is kept too, and so is a turn the agent was in the middle of, which the load carries on.
   */
  sessions?: AcpSessionStore;
  /** Gives the agent what the editor offers: its files, its terminal, and its MCP servers. */
  editor?: AcpEditorBridge;
}

/** What the editor said it can do for the agent, in `initialize`. */
export interface AcpClientCapabilities {
  /** Reading and writing files through the editor, including ones it has open and unsaved. */
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  /** Running commands in the editor's terminals. */
  terminal?: boolean;
}

/** The connection to the editor, as a bridge sees it. */
export interface AcpConnection {
  /** Asks the editor something, such as `fs/read_text_file`, and resolves with its answer or rejects with its error. */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  /** What the editor can do, from `initialize`. */
  capabilities(): AcpClientCapabilities;
  /** A session's directory and MCP servers. */
  session(sessionId: string): AcpSessionInfo | undefined;
}

/** Something that uses the editor's connection, such as `acpEditor()`. `serveAcp()` attaches it when it starts. */
export interface AcpEditorBridge {
  /** Receives the connection to the editor. */
  attach(connection: AcpConnection): void;
  /** Called when the editor closes its end, or the server is closed: the place to stop what it started. */
  detach?(): void | Promise<void>;
}

/** A session as a store keeps it. */
export interface AcpSessionRecord {
  /** The session. */
  info: AcpSessionInfo;
  /** The conversation, tool calls included. Audio is kept as a note of it, not its bytes. */
  history: Message[];
  /** The questions the last turn asked, which the next prompt answers. */
  pending?: ProtocolInterrupt[];
  /** Approvals already given for the paused run, sent with those answers. */
  answered?: Record<string, unknown>;
  /** Tool names a person chose to always allow (true) or always reject (false). */
  always: Array<[string, boolean]>;
  /** The turn the agent is in the middle of, so a load after the agent stopped can carry it on. */
  turn?: AcpTurnRecord;
  /** ISO-8601 time it was last written. */
  updatedAt: string;
}

/** A turn in progress, as a session keeps it. */
export interface AcpTurnRecord {
  /** `invoke` for a prompt that started a run, `resume` for one answering the last turn's questions. */
  kind: 'invoke' | 'resume';
  /** The prompt, as the conversation keeps it. */
  user: Message;
  /** The prompt's blocks, for an `input` that reads them, when the run must start over. */
  blocks?: AcpContentBlock[];
  /** The answers a resume gave, by interrupt id. */
  answers?: Record<string, unknown>;
  /** ISO-8601 time it began. */
  startedAt: string;
}

/** Where an ACP agent keeps its sessions. */
export interface AcpSessionStore {
  /** A session's record. */
  get(sessionId: string): Promise<AcpSessionRecord | undefined> | AcpSessionRecord | undefined;
  /** Writes a session's record. */
  put(record: AcpSessionRecord): Promise<void> | void;
}

/** Sessions in this process: the default. */
export class MemoryAcpSessionStore implements AcpSessionStore {
  private readonly records = new Map<string, AcpSessionRecord>();

  /** A session's record, as a copy. */
  get(sessionId: string): AcpSessionRecord | undefined {
    const record = this.records.get(sessionId);
    return record ? structuredClone(record) : undefined;
  }

  /** Writes a session's record. */
  put(record: AcpSessionRecord): void {
    this.records.set(record.info.id, structuredClone(record));
  }
}

/** Sessions in any long-term `Store`: the memory, Redis, Postgres, or SQLite store. */
export function storeAcpSessions(store: Store, options: { namespace?: readonly string[] } = {}): AcpSessionStore {
  const namespace = [...(options.namespace ?? ['nexus', 'acp', 'sessions'])];
  return {
    async get(sessionId) {
      return (await store.get<AcpSessionRecord>(namespace, sessionId))?.value;
    },
    async put(record) {
      await store.put(namespace, record.info.id, record);
    },
  };
}

/** A running ACP connection. */
export interface AcpServer {
  /** Resolves when the editor closes its end. */
  closed: Promise<void>;
  /** Stops every running prompt. */
  close(): void;
}

interface Session {
  info: AcpSessionInfo;
  history: Message[];
  /** Questions the last turn asked, which the next prompt answers. */
  pending?: ProtocolInterrupt[];
  /** Approvals already given for the paused run, sent with those answers. */
  answered?: Record<string, unknown>;
  /** Tool names a person chose to always allow, or always reject. */
  always: Map<string, boolean>;
  controller?: AbortController;
  /** The turn in progress, kept so a load after the agent stops carries it on. */
  turn?: AcpTurnRecord;
  /** A turn a load is carrying on, which a new prompt waits for. */
  recovering?: Promise<void>;
}

type Incoming = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> } & {
  result?: unknown;
  error?: { code: number; message: string };
};

/**
 * Serves a graph to an editor over ACP. Run it as the agent's process:
 *
 * ```ts
 * serveAcp(agent, { input: process.stdin, output: process.stdout }, { agentInfo: { name: 'reviewer', version: '1.0.0' } });
 * ```
 */
export function serveAcp(graph: ProtocolGraph, streams: AcpStreams, options: AcpOptions = {}): AcpServer {
  const sessions = new Map<string, Session>();
  const store = options.sessions ?? new MemoryAcpSessionStore();
  let capabilities: AcpClientCapabilities = {};
  /** Writes a session as it stands, with audio kept as a note. */
  const save = async (session: Session) => {
    await store.put({
      info: session.info,
      history: storable(session.history),
      ...(session.pending ? { pending: session.pending } : {}),
      ...(session.answered ? { answered: session.answered } : {}),
      always: [...session.always],
      ...(session.turn ? { turn: { ...session.turn, user: storable([session.turn.user])[0] as Message } } : {}),
      updatedAt: new Date().toISOString(),
    });
  };
  const waiting = new Map<string | number, (message: Incoming) => void>();
  let requests = 0;
  const write = (message: unknown) => streams.output.write(`${JSON.stringify(message)}\n`);
  const notify = (sessionId: string, update: AcpSessionUpdate) =>
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  const request = (method: string, params: unknown, signal: AbortSignal) =>
    new Promise<Incoming>((resolve) => {
      const id = `agent-${++requests}`;
      const cancel = () => {
        waiting.delete(id);
        resolve({ result: { outcome: { outcome: 'cancelled' } } });
      };
      if (signal.aborted) return cancel();
      signal.addEventListener('abort', cancel, { once: true });
      waiting.set(id, (message) => {
        signal.removeEventListener('abort', cancel);
        resolve(message);
      });
      write({ jsonrpc: '2.0', id, method, params });
    });
  const kind = options.kind ?? guessKind;
  const answerText = options.answer ?? ((prompt: string) => prompt);

  /** Asks the editor whether a tool call may run, honouring the session's standing choices. */
  const permit = async (
    session: Session,
    interrupt: ProtocolInterrupt,
    signal: AbortSignal,
  ): Promise<boolean | 'cancelled'> => {
    const call = toolCallOf(interrupt) as { id: string; name: string; args: unknown };
    const standing = session.always.get(call.name);
    if (standing !== undefined) return standing;
    const response = await request(
      'session/request_permission',
      {
        sessionId: session.info.id,
        toolCall: {
          toolCallId: call.id,
          title: interrupt.reason ?? titleOf(call.name, call.args),
          kind: kind(call.name, call.args),
          status: 'pending',
          rawInput: call.args,
        },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow_always', name: `Always allow ${call.name}`, kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          { optionId: 'reject_always', name: `Always reject ${call.name}`, kind: 'reject_always' },
        ],
      },
      signal,
    );
    const outcome = (response.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    if (outcome?.outcome !== 'selected') return 'cancelled';
    const allowed = outcome.optionId?.startsWith('allow') ?? false;
    if (outcome.optionId?.endsWith('always')) session.always.set(call.name, allowed);
    return allowed;
  };

  /**
   * Runs a turn to its end: `begin` starts it, a prompt's run or the carrying on of one the agent
   * stopped in the middle of, and the turn then asks for each approval and gives the answer.
   */
  const runTurn = async (
    session: Session,
    begin: (runOptions: ProtocolRunOptions) => Promise<ProtocolResult>,
  ): Promise<AcpStopReason> => {
    session.controller?.abort();
    const controller = new AbortController();
    session.controller = controller;
    const id = session.info.id;
    let spoke = false;
    // A result does not repeat its arguments, which its diff needs.
    const calls = new Map<string, Record<string, unknown>>();
    const runOptions: ProtocolRunOptions = {
      threadId: id,
      signal: controller.signal,
      ...(options.principal ? { principal: options.principal } : {}),
      onEvent: (event: GraphEvent) => {
        if (event.namespace) return;
        if (event.type === 'message' && event.chunk.content) {
          spoke = true;
          notify(id, {
            sessionUpdate: event.chunk.kind === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: event.chunk.content },
          });
        } else if (event.type === 'tool') {
          spoke = false;
          for (const update of toolUpdates(event.tool, kind, calls)) notify(id, update);
        }
      },
    };

    try {
      return await finish(session, await begin(runOptions), runOptions, controller.signal, () => spoke);
    } catch (error) {
      // A cancelled run may end by throwing; the editor is owed a turn that ended as cancelled.
      if (controller.signal.aborted) return 'cancelled';
      throw error;
    } finally {
      session.turn = undefined;
      await save(session);
    }
  };

  /** Runs one prompt to the end of its turn, after any turn a load is still carrying on. */
  const prompt = async (session: Session, blocks: AcpContentBlock[]): Promise<AcpStopReason> => {
    await session.recovering?.catch(() => undefined);
    const id = session.info.id;
    const text = promptText(blocks);
    const media = mediaParts(blocks);
    const user: Message = media.length
      ? { role: 'user', content: [...(text ? [{ type: 'text' as const, text }] : []), ...media] }
      : messageOf('user', text);
    return runTurn(session, async (runOptions) => {
      const startedAt = new Date().toISOString();
      if (session.pending?.length) {
        const answers = {
          ...session.answered,
          ...Object.fromEntries(session.pending.map((item) => [item.id, answerText(text, item)])),
        };
        session.pending = undefined;
        session.answered = undefined;
        session.history.push(user);
        // Kept before the run starts, so a load after the agent stops answers again.
        session.turn = { kind: 'resume', user, answers, startedAt };
        await save(session);
        return graph.resumeInterruptsWith(id, answers, runOptions);
      }
      const history = session.history;
      session.turn = { kind: 'invoke', user, ...(options.input ? { blocks } : {}), startedAt };
      await save(session);
      const result = await graph.invoke(
        options.input ? options.input(text, session.info, history, blocks) : { messages: [...history, user] },
        runOptions,
      );
      session.history = [...history, user];
      return result;
    });
  };

  /**
   * Carries on the turn a stopped agent left: answers its questions again when the graph still waits
   * on them, continues from the graph's last checkpoint, and starts over when it left none.
   */
  const carryOn = async (session: Session, turnRecord: AcpTurnRecord, runOptions: ProtocolRunOptions) => {
    const id = session.info.id;
    const checkpoint = graph.state ? await graph.state(id) : undefined;
    let result: ProtocolResult;
    const waiting = checkpoint?.status === 'awaiting_input' ? (checkpoint.interrupts ?? []) : [];
    if (
      turnRecord.kind === 'resume' &&
      turnRecord.answers &&
      waiting.length > 0 &&
      waiting.every((interrupt) => turnRecord.answers && interrupt.id in turnRecord.answers)
    ) {
      result = await graph.resumeInterruptsWith(id, turnRecord.answers, runOptions);
    } else if (checkpoint && graph.continueWith) {
      result = await graph.continueWith(id, runOptions);
    } else if (!checkpoint && turnRecord.kind === 'invoke') {
      const text = typeof turnRecord.user.content === 'string' ? turnRecord.user.content : '';
      result = await graph.invoke(
        options.input
          ? options.input(text, session.info, session.history, turnRecord.blocks ?? [{ type: 'text', text }])
          : { messages: [...session.history, turnRecord.user] },
        runOptions,
      );
    } else {
      throw new Error('The agent stopped in the middle of this turn, and its graph cannot carry the turn on');
    }
    // A prompt's message joins the conversation once its run has an answer, as it would have.
    if (turnRecord.kind === 'invoke') session.history = [...session.history, turnRecord.user];
    return result;
  };

  /** A turn after its run starts: each approval it waits on, and the answer. */
  const finish = async (
    session: Session,
    started: ProtocolResult,
    runOptions: ProtocolRunOptions,
    signal: AbortSignal,
    spoke: () => boolean,
  ): Promise<AcpStopReason> => {
    const id = session.info.id;
    let result = started;
    while (result.status === 'awaiting_input' && result.interrupts?.length) {
      if (signal.aborted) return 'cancelled';
      const approvals = result.interrupts.filter((item) => toolCallOf(item));
      const questions = result.interrupts.filter((item) => !toolCallOf(item));
      const answers: Record<string, unknown> = {};
      for (const interrupt of approvals) {
        const decision = await permit(session, interrupt, signal);
        if (decision === 'cancelled') return 'cancelled';
        answers[interrupt.id] = decision;
      }
      if (questions.length) {
        // ACP has no question but a permission, so the agent asks in words and the next prompt answers.
        notify(id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: questions.map(questionOf).join('\n') },
        });
        session.pending = questions;
        session.answered = answers;
        return 'end_turn';
      }
      result = await graph.resumeInterruptsWith(id, answers, runOptions);
    }
    if (signal.aborted || result.status === 'interrupted') return 'cancelled';
    const answer = answerOf(result.state);
    if (!spoke() && answer)
      notify(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } });
    session.history = transcriptOf(result.state, [...session.history, messageOf('assistant', answer)]);
    return (result.state as { stopReason?: string } | null)?.stopReason === 'max_iterations'
      ? 'max_turn_requests'
      : 'end_turn';
  };

  /** Carries on a turn a load found in progress, once the load has answered; tells the editor if it cannot. */
  const recoverTurn = (session: Session, turnRecord: AcpTurnRecord) => {
    session.turn = turnRecord;
    const recovering = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => runTurn(session, (runOptions) => carryOn(session, turnRecord, runOptions)))
      .then(
        () => undefined,
        (error: unknown) => {
          notify(session.info.id, {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `The turn the agent was in the middle of could not be carried on: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
        },
      )
      .finally(() => {
        if (session.recovering === recovering) session.recovering = undefined;
      });
    session.recovering = recovering;
  };

  const handle = async (message: Incoming): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case 'initialize':
        capabilities = (params.clientCapabilities ?? {}) as AcpClientCapabilities;
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: true, embeddedContext: true },
          },
          authMethods: [],
          ...(options.agentInfo ? { agentInfo: options.agentInfo } : {}),
        };
      case 'authenticate':
        return {};
      case 'session/new': {
        const info: AcpSessionInfo = {
          id: protocolId('session'),
          cwd: typeof params.cwd === 'string' ? params.cwd : '',
          mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
        };
        const session: Session = { info, history: [], always: new Map() };
        sessions.set(info.id, session);
        await save(session);
        return { sessionId: info.id };
      }
      case 'session/load': {
        const sessionId = String(params.sessionId ?? '');
        const record = await store.get(sessionId);
        if (!record) throw Object.assign(new Error(`Session ${sessionId} was not found`), { code: -32602 });
        // The editor may reopen it elsewhere, with other servers.
        const info: AcpSessionInfo = {
          id: sessionId,
          cwd: typeof params.cwd === 'string' ? params.cwd : record.info.cwd,
          mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : record.info.mcpServers,
        };
        const session: Session = {
          info,
          history: record.history,
          ...(record.pending ? { pending: record.pending } : {}),
          ...(record.answered ? { answered: record.answered } : {}),
          always: new Map(record.always),
        };
        sessions.get(sessionId)?.controller?.abort();
        sessions.set(sessionId, session);
        for (const update of replay(session.history, kind)) notify(sessionId, update);
        if (session.pending?.length) {
          notify(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: session.pending.map(questionOf).join('\n') },
          });
        }
        await save(session);
        // A turn the agent stopped in the middle of goes on, its updates streamed as they happen.
        if (record.turn) recoverTurn(session, record.turn);
        return null;
      }
      case 'session/prompt': {
        const session = sessions.get(String(params.sessionId));
        if (!session)
          throw Object.assign(new Error(`Session ${String(params.sessionId)} was not found`), { code: -32602 });
        return {
          stopReason: await prompt(session, Array.isArray(params.prompt) ? (params.prompt as AcpContentBlock[]) : []),
        };
      }
      default:
        throw Object.assign(new Error(`Method ${String(message.method)} is not supported`), { code: -32601 });
    }
  };

  const receive = (message: Incoming) => {
    if (message.method === undefined) {
      // A response to a request the agent made.
      if (message.id !== undefined && message.id !== null) waiting.get(message.id)?.(message);
      waiting.delete(message.id as string);
      return;
    }
    if (message.id === undefined || message.id === null) {
      if (message.method === 'session/cancel') sessions.get(String(message.params?.sessionId))?.controller?.abort();
      return;
    }
    handle(message).then(
      (result) => write({ jsonrpc: '2.0', id: message.id, result }),
      (error: Error & { code?: unknown }) =>
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: typeof error.code === 'number' ? error.code : -32603, message: error.message },
        }),
    );
  };

  options.editor?.attach({
    async request(method, params, signal) {
      const response = await request(method, params, signal ?? new AbortController().signal);
      if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
      const outcome = (response.result as { outcome?: { outcome?: string } } | undefined)?.outcome;
      if (signal?.aborted && outcome?.outcome === 'cancelled') throw new Error('The request was cancelled');
      return response.result;
    },
    capabilities: () => capabilities,
    session: (sessionId) => sessions.get(sessionId)?.info,
  });

  const closed = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of streams.input) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            receive(JSON.parse(line) as Incoming);
          } catch {
            write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'A line is not JSON' } });
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
    // The editor closed its end: what the bridge started for it, such as MCP servers, stops too.
    await options.editor?.detach?.();
  })();

  return {
    closed,
    close() {
      for (const session of sessions.values()) session.controller?.abort();
      void options.editor?.detach?.();
    },
  };
}

/** The editor updates for one tool event: the call, its plan, and its result. */
function toolUpdates(
  tool: Extract<GraphEvent, { type: 'tool' }>['tool'],
  kind: (name: string, args: unknown) => AcpToolKind,
  calls: Map<string, Record<string, unknown>>,
): AcpSessionUpdate[] {
  const args = (tool.args ?? calls.get(tool.id) ?? {}) as Record<string, unknown>;
  if (tool.phase === 'start') {
    calls.set(tool.id, args);
    const updates: AcpSessionUpdate[] = [
      {
        sessionUpdate: 'tool_call',
        toolCallId: tool.id,
        title: titleOf(tool.name, args),
        kind: kind(tool.name, args),
        status: 'in_progress',
        rawInput: args,
        ...(typeof args.path === 'string' ? { locations: [{ path: args.path }] } : {}),
      },
    ];
    if (tool.name === 'write_todos' && Array.isArray(args.todos)) {
      updates.push({
        sessionUpdate: 'plan',
        entries: (args.todos as Array<{ content?: unknown; status?: unknown }>).map((todo) => ({
          content: String(todo.content ?? ''),
          priority: 'medium',
          status: todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending',
        })),
      });
    }
    return updates;
  }
  if (tool.phase === 'progress') {
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: tool.id,
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: asText(tool.progress) } }],
      },
    ];
  }
  if (tool.phase !== 'result' && tool.phase !== 'error') return [];
  const content: unknown[] = [];
  if (tool.phase === 'result' && typeof args.path === 'string') {
    const oldText = args.old_text ?? args.oldText;
    const newText = args.new_text ?? args.newText ?? (tool.name === 'write_file' ? args.content : undefined);
    if (typeof newText === 'string') {
      content.push({ type: 'diff', path: args.path, oldText: typeof oldText === 'string' ? oldText : null, newText });
    }
  }
  content.push({
    type: 'content',
    content: { type: 'text', text: tool.phase === 'result' ? asText(tool.result) : (tool.error ?? 'The tool failed') },
  });
  return [
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: tool.id,
      status: tool.phase === 'result' ? 'completed' : 'failed',
      content,
      ...(tool.phase === 'result' ? { rawOutput: tool.result } : {}),
    },
  ];
}

/** A tool's kind from its name: `read_file` reads, `edit_file` edits, `execute` runs a command. */
function guessKind(name: string): AcpToolKind {
  const lower = name.toLowerCase();
  if (lower === 'write_todos' || /think|plan/.test(lower)) return 'think';
  if (/delete|remove|^rm$/.test(lower)) return 'delete';
  if (/move|rename|^mv$/.test(lower)) return 'move';
  if (/edit|write|patch|replace|create/.test(lower)) return 'edit';
  if (/grep|glob|search|find|query/.test(lower)) return 'search';
  if (/read|^ls$|list|cat|open|view/.test(lower)) return 'read';
  if (/exec|shell|bash|run|command|terminal/.test(lower)) return 'execute';
  if (/fetch|http|url|web|download|browse/.test(lower)) return 'fetch';
  return 'other';
}

function titleOf(name: string, args: unknown): string {
  const values = (args ?? {}) as Record<string, unknown>;
  const subject = [values.path, values.command, values.query, values.url, values.pattern].find(
    (value) => typeof value === 'string',
  ) as string | undefined;
  return subject ? `${name} ${subject}` : name;
}

function questionOf(interrupt: ProtocolInterrupt): string {
  return (
    interrupt.reason ??
    (interrupt.payload === undefined ? 'The agent needs an answer to continue.' : asText(interrupt.payload))
  );
}

/** A prompt's image and audio blocks, as content parts the model sees. */
function mediaParts(blocks: readonly AcpContentBlock[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'image' && block.data) {
      parts.push({
        type: 'image',
        source: { base64: block.data, ...(block.mimeType ? { mimeType: block.mimeType } : {}) },
      });
    } else if (block.type === 'image' && block.uri) {
      parts.push({ type: 'image', source: { url: block.uri } });
    } else if (block.type === 'audio' && block.data) {
      const bytes = Uint8Array.from(atob(block.data), (character) => character.charCodeAt(0));
      parts.push({
        type: 'audio',
        source: { buffer: bytes as never, ...(block.mimeType ? { format: block.mimeType.split('/')[1] } : {}) },
      });
    }
  }
  return parts;
}

/** A history a store can keep as JSON: audio becomes a note that it was heard, images stay. */
function storable(history: readonly Message[]): Message[] {
  return history.map((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === 'audio')
      ? {
          ...message,
          content: message.content.map((part) =>
            part.type === 'audio' ? { type: 'text' as const, text: '[audio the user sent]' } : part,
          ),
        }
      : message,
  );
}

/** A session's history as the updates an editor replays when it loads the session. */
function replay(history: readonly Message[], kind: (name: string, args: unknown) => AcpToolKind): AcpSessionUpdate[] {
  const updates: AcpSessionUpdate[] = [];
  for (const message of history) {
    const blocks = (
      Array.isArray(message.content) ? message.content : [{ type: 'text' as const, text: message.content }]
    ).flatMap((part): Array<Record<string, unknown>> => {
      if (part.type === 'text' && part.text) return [{ type: 'text', text: part.text }];
      if (part.type === 'image' && 'base64' in part.source) {
        return [{ type: 'image', data: part.source.base64, mimeType: part.source.mimeType ?? 'image/png' }];
      }
      return [];
    });
    if (message.role === 'user') {
      for (const content of blocks) updates.push({ sessionUpdate: 'user_message_chunk', content });
    } else if (message.role === 'assistant') {
      for (const content of blocks) updates.push({ sessionUpdate: 'agent_message_chunk', content });
      for (const call of message.toolCalls ?? []) {
        let args: unknown = call.function.arguments;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          // Kept as written.
        }
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: call.id,
          title: titleOf(call.function.name, args),
          kind: kind(call.function.name, args),
          status: 'completed',
          rawInput: args,
        });
      }
    } else if (message.role === 'tool' && message.toolCallId) {
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: message.toolCallId,
        status: 'completed',
        content: blocks.map((content) => ({ type: 'content', content })),
      });
    }
  }
  return updates;
}

/** A prompt's blocks as one text: embedded files fenced with their URI, links named. */
function promptText(blocks: readonly AcpContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'resource' && typeof block.resource?.text === 'string') {
        return `${block.resource.uri}\n\`\`\`\n${block.resource.text}\n\`\`\``;
      }
      if (block.type === 'resource_link' && block.uri) return `@${block.uri}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}
