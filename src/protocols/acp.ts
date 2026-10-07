/**
 * ACP, the Agent Client Protocol: a Nexus agent inside an editor. The editor starts the agent as a
 * subprocess and the two speak JSON-RPC 2.0, one message per line, over stdin and stdout.
 *
 * Each editor session is a conversation. While a prompt runs, the editor sees:
 * - the agent's text as it streams;
 * - each tool call, with its kind, the file it touches, and its result or diff;
 * - the plan, as `write_todos` records it.
 *
 * A tool call that needs approval asks the editor, which shows the person allow and reject choices.
 * A choice to always allow or always reject is kept for the rest of the session.
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

/** One block of a prompt: text, a file the editor embedded, or a link to one. */
export interface AcpContentBlock {
  /** `text`, `resource`, `resource_link`, or a kind this agent does not read, such as `image`. */
  type: string;
  /** A text block's text. */
  text?: string;
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
  input?: (prompt: string, session: AcpSessionInfo, history: Message[]) => unknown;
  /**
   * The answer the next prompt gives a question that is not a tool approval. Such a question is
   * asked as the agent's message, and the turn ends. Defaults to the prompt's text.
   */
  answer?: (prompt: string, interrupt: ProtocolInterrupt) => unknown;
  /** What a tool does, for the editor. Defaults to a guess from its name. */
  kind?: (name: string, args: unknown) => AcpToolKind;
  /** Who the agent acts for: the person at the editor. */
  principal?: Principal;
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

  /** Runs one prompt to the end of its turn. */
  const prompt = async (session: Session, blocks: AcpContentBlock[]): Promise<AcpStopReason> => {
    session.controller?.abort();
    const controller = new AbortController();
    session.controller = controller;
    const id = session.info.id;
    const text = promptText(blocks);
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
      return await turn(session, text, runOptions, controller.signal, () => spoke);
    } catch (error) {
      // A cancelled run may end by throwing; the editor is owed a turn that ended as cancelled.
      if (controller.signal.aborted) return 'cancelled';
      throw error;
    }
  };

  /** A prompt's turn: the run, each approval it waits on, and the answer. */
  const turn = async (
    session: Session,
    text: string,
    runOptions: ProtocolRunOptions,
    signal: AbortSignal,
    spoke: () => boolean,
  ): Promise<AcpStopReason> => {
    const id = session.info.id;
    const user = messageOf('user', text);
    let result: ProtocolResult;
    if (session.pending?.length) {
      const answers = {
        ...session.answered,
        ...Object.fromEntries(session.pending.map((item) => [item.id, answerText(text, item)])),
      };
      session.pending = undefined;
      session.answered = undefined;
      session.history.push(user);
      result = await graph.resumeInterruptsWith(id, answers, runOptions);
    } else {
      const history = session.history;
      result = await graph.invoke(
        options.input ? options.input(text, session.info, history) : { messages: [...history, user] },
        runOptions,
      );
      session.history = [...history, user];
    }

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

  const handle = async (message: Incoming): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
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
        sessions.set(info.id, { info, history: [], always: new Map() });
        return { sessionId: info.id };
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
  })();

  return {
    closed,
    close() {
      for (const session of sessions.values()) session.controller?.abort();
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
