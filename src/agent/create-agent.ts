import { appendList, counter, lastValue } from '../graph/channels.js';
import { type CompiledGraph, createGraph } from '../graph/graph.js';
import type { GraphCheckpointer, NodeContext } from '../types/graph.js';
import { Command, END, Send } from '../types/graph.js';
import type { CompletionRequest, Message, ToolDefinition } from '../types/messages.js';
import type { NexusResponse, ToolCall } from '../types/response.js';
import type { Store } from '../types/store.js';
import { ToolExecutor } from './tool.js';

/**
 * An agent as a graph.
 *
 * `AgentLoop` is a `while` loop: it cannot be paused, resumed after a restart, inspected halfway, or
 * made to run two tool calls at once, because a loop has nowhere to keep that state. The same agent
 * expressed as a graph inherits all of it — checkpoints, human approval through `interrupt()`,
 * parallel tool tasks through `Send`, forks, events, and a Mermaid diagram — without this module
 * implementing any of them. `AgentLoop` stays for the simple case that wants none of that.
 */

/** The model call an agent makes. Injected, so this module needs no provider runtime. */
export interface AgentModelClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** What an approver may answer: allow, refuse with a reason, or allow with corrected arguments. */
export type AgentApproval =
  | boolean
  | { approved: true; args?: Record<string, unknown> }
  | { approved: false; reason?: string };

export interface AgentApprovalPolicy {
  /** The question an operator sees. Defaults to naming the tool and its arguments. */
  reason?: (call: AgentToolCall) => string;
}

export interface AgentMiddleware {
  name?: string;
  /** Adjusts the request before it is sent: trim history, add context, swap the model. */
  beforeModel?(context: {
    request: CompletionRequest;
    state: AgentState;
    store?: Store;
    // biome-ignore lint/suspicious/noConfusingVoidType: returning nothing means "leave the request as it is", which is the common case.
  }): CompletionRequest | void | Promise<CompletionRequest | void>;
  /** Inspects or replaces the response: redact, validate, count. */
  afterModel?(context: {
    response: NexusResponse;
    state: AgentState;
    store?: Store;
    // biome-ignore lint/suspicious/noConfusingVoidType: returning nothing means "leave the response as it is".
  }): NexusResponse | void | Promise<NexusResponse | void>;
  /** Wraps a tool call, so a policy can log it, time it, or refuse it. */
  wrapToolCall?(call: AgentToolCall, next: () => Promise<AgentToolResult>): Promise<AgentToolResult> | AgentToolResult;
}

export interface AgentToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CreateAgentOptions {
  client: AgentModelClient;
  model?: string;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  /** Model calls before the agent stops with `stopReason: 'max_iterations'`. Defaults to 8. */
  maxIterations?: number;
  /** Tool calls run at once. Defaults to 8; `1` runs them one at a time. */
  toolConcurrency?: number;
  /** Tools that need human approval before they run, keyed by tool name. */
  interruptOn?: Record<string, AgentApprovalPolicy | true>;
  middleware?: AgentMiddleware[];
  /** Long-term memory, available to tools and middleware as `store`. */
  store?: Store;
  checkpointer?: GraphCheckpointer | false;
  name?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: CompletionRequest['responseFormat'];
  metadata?: Record<string, unknown>;
}

const agentChannels = () => ({
  messages: appendList<Message>(),
  iterations: counter(),
  answer: lastValue<string>(''),
  stopReason: lastValue<AgentStopReason | undefined>(undefined),
});

export type AgentChannels = ReturnType<typeof agentChannels>;
export type AgentState = {
  messages: Message[];
  iterations: number;
  answer: string;
  stopReason?: AgentStopReason;
};
export type AgentStopReason = 'completed' | 'max_iterations';
export type AgentGraph = CompiledGraph<AgentChannels>;

/** Wraps a question into the state an agent starts from. */
export function agentInput(goal: string): { messages: Message[] } {
  return { messages: [{ role: 'user', content: goal }] };
}

/**
 * Builds an agent and returns it as a compiled graph.
 *
 * Run it like any graph: `agent.invoke(agentInput('...'), { threadId })`. The result's `answer` is
 * the final text, and `stopReason` says whether the agent finished or ran out of iterations.
 */
export function createAgent(options: CreateAgentOptions): AgentGraph {
  if (typeof options.client?.complete !== 'function') {
    throw new TypeError('createAgent needs a client with a complete() method');
  }

  const maxIterations = Math.max(1, options.maxIterations ?? 8);
  const executor = new ToolExecutor(options.tools ?? []);
  const middleware = options.middleware ?? [];
  const approvals = options.interruptOn ?? {};

  const graph = createGraph({ channels: agentChannels() })
    .addNode(
      'model',
      async (context) => {
        const state = context.state as AgentState;
        let request: CompletionRequest = {
          model: options.model ?? 'auto',
          messages: [
            ...(options.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
            ...state.messages,
          ],
          ...(options.tools?.length ? { tools: executor.list() } : {}),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
        };

        for (const item of middleware) {
          request = (await item.beforeModel?.({ request, state, store: options.store })) ?? request;
        }

        let response = await options.client.complete(request);
        for (const item of middleware) {
          response = (await item.afterModel?.({ response, state, store: options.store })) ?? response;
        }

        const assistant: Message = {
          role: 'assistant',
          content: response.content,
          ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
        };
        const calls = response.toolCalls ?? [];

        if (calls.length === 0) {
          return new Command({
            update: { messages: [assistant], iterations: 1, answer: response.content, stopReason: 'completed' },
            goto: END,
          });
        }
        if (state.iterations + 1 >= maxIterations) {
          // The model still wants tools but has used its budget; say so rather than pretending the
          // last message is an answer.
          return new Command({
            update: { messages: [assistant], iterations: 1, answer: response.content, stopReason: 'max_iterations' },
            goto: END,
          });
        }
        return new Command({
          update: { messages: [assistant], iterations: 1 },
          goto: calls.map((call) => new Send('tools', call)),
        });
      },
      { ends: ['tools', END] },
    )
    .addNode(
      'tools',
      async (context) => {
        const call = context.input as ToolCall;
        const parsed = parseArguments(call.function.arguments);
        if (!parsed.ok) {
          return { messages: [toolMessage(call, { ok: false, error: parsed.error })] };
        }

        let args = parsed.args;
        const description: AgentToolCall = { id: call.id, name: call.function.name, args };
        const policy = approvals[description.name];
        if (policy) {
          const decision = context.interrupt<AgentApproval>({
            reason: (policy === true ? undefined : policy.reason?.(description)) ?? defaultReason(description),
            payload: description,
          });
          const verdict = normalizeApproval(decision);
          if (!verdict.approved) {
            return {
              messages: [toolMessage(call, { ok: false, error: verdict.reason ?? 'A human refused this tool call' })],
            };
          }
          if (verdict.args) args = verdict.args;
        }

        const run = async (): Promise<AgentToolResult> => executor.execute(description.name, args);
        const result = await middleware.reduceRight<() => Promise<AgentToolResult>>(
          (next, item) =>
            item.wrapToolCall
              ? () => Promise.resolve(item.wrapToolCall?.({ ...description, args }, next) as AgentToolResult)
              : next,
          run,
        )();

        return { messages: [toolMessage(call, result)] };
      },
      { ends: ['model'] },
    )
    .setEntry('model')
    .addEdge('tools', 'model');

  return graph.compile({
    // Each iteration is two supersteps, plus the entry and a margin for a paused approval.
    maxSteps: maxIterations * 2 + 4,
    maxConcurrency: options.toolConcurrency ?? 8,
    ...(options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer }),
    ...(options.store ? { store: options.store } : {}),
    ...(options.name ? { name: options.name } : {}),
  });
}

/**
 * Turns an agent into a tool another agent can call.
 *
 * The simplest multi-agent shape: a supervisor keeps control and delegates, rather than handing over
 * the conversation. The specialist runs as its own graph, with its own memory and approvals, and
 * returns its answer as the tool result.
 */
export function agentAsTool(options: {
  agent: AgentGraph;
  name: string;
  description: string;
  /** Threads the specialist's runs, so its work is resumable too. Defaults to a fresh thread. */
  threadId?: (goal: string) => string;
}): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties: { goal: { type: 'string', description: 'What this agent should do' } },
      required: ['goal'],
    },
    execute: async (args: Record<string, unknown>) => {
      const goal = String(args.goal ?? '');
      const result = await options.agent.invoke(agentInput(goal), {
        ...(options.threadId ? { threadId: options.threadId(goal) } : {}),
      });
      if (result.status === 'awaiting_input') {
        return `The ${options.name} agent is waiting for a human: ${result.interrupt?.reason ?? 'approval needed'}`;
      }
      return result.state.answer;
    },
  };
}

/** Turns a tool result into the message the model reads next. */
function toolMessage(call: ToolCall, result: AgentToolResult): Message {
  return {
    role: 'tool',
    toolCallId: call.id,
    content: JSON.stringify(result.ok ? (result.result ?? null) : { error: result.error }),
  };
}

function defaultReason(call: AgentToolCall): string {
  return `Run tool "${call.name}" with ${JSON.stringify(call.args)}?`;
}

function normalizeApproval(decision: AgentApproval): {
  approved: boolean;
  args?: Record<string, unknown>;
  reason?: string;
} {
  if (typeof decision === 'boolean') return { approved: decision };
  return decision.approved
    ? { approved: true, ...(decision.args ? { args: decision.args } : {}) }
    : { approved: false, ...(decision.reason ? { reason: decision.reason } : {}) };
}

type ParsedArguments = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/** Arguments the model did not actually send must never reach a tool. */
function parseArguments(raw: string): ParsedArguments {
  if (!raw?.trim()) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { ok: true, args: parsed };
    return { ok: false, error: 'Tool arguments must be a JSON object; the tool was not run' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Tool arguments are not valid JSON (${reason}); the tool was not run` };
  }
}

export type { NodeContext };
