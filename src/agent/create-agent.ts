import type { OperationLifecycleLike } from '../types/lifecycle.js';
import { appendList, counter, lastValue } from '../graph/channels.js';
import { type CompiledGraph, createGraph } from '../graph/graph.js';
import type { GraphCheckpointer, InterruptRequest, NodeContext } from '../types/graph.js';
import { Command, END, Send } from '../types/graph.js';
import type { CompletionRequest, Message, ToolDefinition } from '../types/messages.js';
import type { NexusResponse, ResponseMeta, StreamChunk, ToolCall } from '../types/response.js';
import type { Principal } from '../types/principal.js';
import type { Store } from '../types/store.js';
import { capabilitiesOf } from './capabilities.js';
import type { PermissionPolicyLike } from './permissions.js';
import { ToolExecutor, toolMessageContent } from './tool.js';

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
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<NexusResponse>;
  /** Streams one completion. Used when the agent is created with `streamTokens`. */
  stream?(request: CompletionRequest): AsyncIterable<StreamChunk>;
}

/** A tool call the agent is about to make. */
export interface AgentToolCall {
  /** The model's id for the call. */
  id: string;
  /** The tool's name. */
  name: string;
  /** Arguments, parsed from the model's JSON. */
  args: Record<string, unknown>;
  /** What the call declares it does, when the tool declares capabilities. */
  capabilities?: readonly string[];
  /** Why the permission policy asked for approval, when it did. */
  permission?: string;
}

/** What an approver may answer: allow, refuse with a reason, or allow with corrected arguments. */
export type AgentApproval =
  | boolean
  | { approved: true; args?: Record<string, unknown> }
  | { approved: false; reason?: string };

/** How a call to a tool that needs approval is presented to the operator. */
export interface AgentApprovalPolicy {
  /** The question an operator sees. Defaults to naming the tool and its arguments. */
  reason?: (call: AgentToolCall) => string;
}

/** What every middleware hook can read about the step it runs in. */
export interface AgentMiddlewareContext {
  /** The agent's state at this step: the whole transcript, tool calls and results included. */
  state: AgentState;
  /** Long-term memory, when the agent has a store. */
  store?: Store;
  /** The thread the run belongs to. */
  threadId: string;
  /** The tenant the run is for, when it has one. */
  tenantId?: string;
  /** Who the run is for, when it has a principal: the caller the server authenticated. */
  principal?: Readonly<Principal>;
  /** Aborted when the run is cancelled or the step times out. A hook that waits should stop with it. */
  signal: AbortSignal;
  /**
   * Suspends the run until a person answers, as `interruptOn` does. When the run resumes, the step
   * runs again and this returns the answer instead of suspending.
   */
  interrupt<T = unknown>(request: InterruptRequest): T;
}

/** What `wrapModelCall` can read, and how it ends the run without calling the model. */
export interface AgentModelCallContext extends AgentMiddlewareContext {
  /**
   * Ends the run with this answer and `stopReason: 'stopped'`, without another model call. Return
   * what it returns: `return context.stop('The model call limit was reached.')`.
   */
  stop(answer: string): NexusResponse;
}

/** Hooks around the agent's model calls and tool calls. Each hook is optional. */
export interface AgentMiddleware {
  /** Names the middleware in traces and errors. */
  name?: string;
  /** Adjusts the request before it is sent: trim history, add context, swap the model. */
  beforeModel?(
    context: AgentMiddlewareContext & { request: CompletionRequest },
    // biome-ignore lint/suspicious/noConfusingVoidType: returning nothing means "leave the request as it is", which is the common case.
  ): CompletionRequest | void | Promise<CompletionRequest | void>;
  /** Inspects or replaces the response: redact, validate, count. */
  afterModel?(
    context: AgentMiddlewareContext & { response: NexusResponse },
    // biome-ignore lint/suspicious/noConfusingVoidType: returning nothing means "leave the response as it is".
  ): NexusResponse | void | Promise<NexusResponse | void>;
  /**
   * Wraps the model call itself, after every `beforeModel` and before every `afterModel`. `next`
   * sends a request and may be called again, with the same request or a changed one, to retry or to
   * fall back to another model. The first middleware is the outermost.
   */
  wrapModelCall?(
    request: CompletionRequest,
    next: (request: CompletionRequest) => Promise<NexusResponse>,
    context: AgentModelCallContext,
  ): Promise<NexusResponse> | NexusResponse;
  /**
   * Wraps a tool call, so a policy can log it, time it, retry it, or refuse it. `next` runs the
   * rest of the chain and may be called again; given a call, it runs that call's arguments instead,
   * and the permission policy decides them again first. The first middleware is the outermost.
   */
  wrapToolCall?(
    call: AgentToolCall,
    next: (call?: AgentToolCall) => Promise<AgentToolResult>,
    context: AgentMiddlewareContext,
  ): Promise<AgentToolResult> | AgentToolResult;
}

/** What a tool call produced. */
export interface AgentToolResult {
  /** True when the tool returned a value. */
  ok: boolean;
  /** The value returned. */
  result?: unknown;
  /** Why the tool failed. */
  error?: string;
}

/** Options for `createAgent()`. */
export interface CreateAgentOptions {
  /** Client the model is called through. */
  client: AgentModelClient;
  /** Model to use. Defaults to the client's routing. */
  model?: string;
  /** Tools the model may call. */
  tools?: ToolDefinition[];
  /** System prompt placed before the conversation. */
  systemPrompt?: string;
  /** Model calls before the agent stops with `stopReason: 'max_iterations'`. Defaults to 8. */
  maxIterations?: number;
  /** Tool calls run at once. Defaults to 8; `1` runs them one at a time. */
  toolConcurrency?: number;
  /** Tools that need human approval before they run, keyed by tool name. */
  interruptOn?: Record<string, AgentApprovalPolicy | true>;
  /** Hooks around model and tool calls, applied in order. */
  middleware?: AgentMiddleware[];
  /**
   * Decides every tool call from the capabilities it declares, before it runs: allow it, deny it,
   * or interrupt for a person's approval, as `interruptOn` does. A denied call reaches the model as a
   * failed tool result naming the reason, and never runs. See `permissionPolicy()` in
   * `nexus-ai-pro/agent/permissions`.
   */
  permissions?: PermissionPolicyLike;
  /** Long-term memory, available to tools and middleware as `store`. */
  store?: Store;
  /**
   * Where checkpoints go. Defaults to the graph's in-process checkpointer; `false` disables them,
   * and with them approvals.
   */
  checkpointer?: GraphCheckpointer | false;
  /** Names the agent in checkpoints and traces. */
  name?: string;
  /** Sampling temperature. */
  temperature?: number;
  /** Output token limit. */
  maxTokens?: number;
  /** Structured output format for answers. */
  responseFormat?: CompletionRequest['responseFormat'];
  /** Application data sent with every model request. */
  metadata?: Record<string, unknown>;
  /**
   * Runs every invocation as one operation of a client's lifecycle, labelled `agent`: pass
   * `ai.lifecycle`. Its model calls are operations of their own.
   */
  lifecycle?: OperationLifecycleLike;
  /**
   * Streams the model's output token by token onto the run's `messages` events, through the client's
   * `stream()`. Without it, or with a client that cannot stream, each answer arrives as one message
   * event once the model returns. Middleware sees the assembled response either way.
   */
  streamTokens?: boolean;
}

const agentChannels = () => ({
  messages: appendList<Message>(),
  iterations: counter(),
  answer: lastValue<string>(''),
  stopReason: lastValue<AgentStopReason | undefined>(undefined),
});

/** The agent's state channels, as a graph schema. */
export type AgentChannels = ReturnType<typeof agentChannels>;
/** The agent's state. */
export type AgentState = {
  /** The conversation, tool calls and results included. */
  messages: Message[];
  /** Model calls made so far. */
  iterations: number;
  /** The final answer, once the model stops calling tools. */
  answer: string;
  /** Why the agent stopped. */
  stopReason?: AgentStopReason;
};
/**
 * `completed` when the model answered, `max_iterations` when it ran out of model calls, `stopped`
 * when a middleware ended the run through `context.stop()`.
 */
export type AgentStopReason = 'completed' | 'max_iterations' | 'stopped';
/** An agent: a compiled graph over the agent's channels. */
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

        const hooks = hookContext(context, state, options.store);
        for (const item of middleware) {
          request = (await item.beforeModel?.({ ...hooks, request })) ?? request;
        }

        const streaming = Boolean(options.streamTokens && options.client.stream);
        const send = (next: CompletionRequest): Promise<NexusResponse> =>
          streaming && options.client.stream
            ? streamed(options.client.stream(next), (chunk) => context.message(chunk))
            : options.client.complete(next);
        // A response made by context.stop() is recognized by identity, before afterModel can replace it.
        const stops = new WeakSet<NexusResponse>();
        const modelContext: AgentModelCallContext = {
          ...hooks,
          stop: (answer) => {
            const stopped = stopResponse(answer, request.model);
            stops.add(stopped);
            return stopped;
          },
        };
        const wrapped = middleware.reduceRight<(request: CompletionRequest) => Promise<NexusResponse>>((next, item) => {
          const wrap = item.wrapModelCall?.bind(item);
          return wrap ? (current) => Promise.resolve(wrap(current, next, modelContext)) : next;
        }, send);
        let response = await wrapped(request);
        const stopped = stops.has(response);
        if ((!streaming || stopped) && response.content) {
          context.message({ content: response.content });
        }
        for (const item of middleware) {
          response = (await item.afterModel?.({ ...hooks, response })) ?? response;
        }

        const assistant: Message = {
          role: 'assistant',
          content: response.content,
          ...(response.toolCalls?.length && !stopped ? { toolCalls: response.toolCalls } : {}),
        };
        const calls = stopped ? [] : (response.toolCalls ?? []);

        if (stopped) {
          return new Command({
            update: { messages: [assistant], iterations: 1, answer: response.content, stopReason: 'stopped' },
            goto: END,
          });
        }
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
        const definition = executor.get(call.function.name);
        const capabilities = capabilitiesOf(definition, args);
        const description: AgentToolCall = {
          id: call.id,
          name: call.function.name,
          args,
          ...(capabilities ? { capabilities } : {}),
        };
        const refuse = (error: string) => {
          context.tool({ phase: 'error', id: call.id, name: description.name, error });
          return { messages: [toolMessage(call, { ok: false, error })] };
        };

        // The policy decides before anything runs; a denial never reaches the tool.
        let permission: string | undefined;
        if (options.permissions) {
          const verdict = await options.permissions.decide({
            tool: description.name,
            args,
            capabilities,
            ...(context.principal ? { principal: context.principal } : {}),
          });
          if (verdict.decision === 'deny') return refuse(`Permission denied: ${verdict.reason}`);
          if (verdict.decision === 'ask') permission = verdict.reason;
        }

        const policy = approvals[description.name];
        if (policy || permission) {
          const asked: AgentToolCall = permission ? { ...description, permission } : description;
          const decision = context.interrupt<AgentApproval>({
            reason:
              (policy && policy !== true ? policy.reason?.(asked) : undefined) ??
              (permission ? `${defaultReason(asked)} (${permission})` : defaultReason(asked)),
            payload: asked,
          });
          const verdict = normalizeApproval(decision);
          if (!verdict.approved) return refuse(verdict.reason ?? 'A human refused this tool call');
          if (verdict.args) {
            args = verdict.args;
            // Arguments an approver changed are checked again: an edit cannot reach what the policy denies.
            if (options.permissions) {
              const recheck = await options.permissions.decide({
                tool: description.name,
                args,
                capabilities: capabilitiesOf(definition, args),
              });
              if (recheck.decision === 'deny') return refuse(`Permission denied: ${recheck.reason}`);
            }
          }
        }

        // The tool that runs is always the one the model named; a middleware can change only the arguments,
        // and changed arguments are decided again, so no middleware can reach what the policy denies.
        const run = async (current: AgentToolCall): Promise<AgentToolResult> => {
          if (options.permissions && current.args !== args) {
            const recheck = await options.permissions.decide({
              tool: description.name,
              args: current.args,
              capabilities: capabilitiesOf(definition, current.args),
            });
            if (recheck.decision === 'deny') return { ok: false, error: `Permission denied: ${recheck.reason}` };
          }
          return executor.execute(description.name, current.args, {
            toolCallId: call.id,
            threadId: context.threadId,
            ...(context.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
            ...(context.principal ? { principal: context.principal } : {}),
            signal: context.signal,
            ...(context.store ? { store: context.store } : {}),
          });
        };
        context.tool({ phase: 'start', id: call.id, name: description.name, args });
        const hooks = hookContext(context, context.state as AgentState, options.store);
        const result = await middleware.reduceRight<(call: AgentToolCall) => Promise<AgentToolResult>>((next, item) => {
          const wrap = item.wrapToolCall?.bind(item);
          return wrap
            ? (current) => Promise.resolve(wrap(current, (changed) => next(changed ?? current), hooks))
            : next;
        }, run)({ ...description, args });
        context.tool(
          result.ok
            ? { phase: 'result', id: call.id, name: description.name, result: result.result }
            : { phase: 'error', id: call.id, name: description.name, error: result.error ?? 'The tool failed' },
        );

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
    ...(options.lifecycle ? { lifecycle: options.lifecycle, lifecycleFamily: 'agent' as const } : {}),
    // What each tool declares and how its calls are approved, for describe() and the linter.
    tools: executor.list().map((definition) => ({
      name: definition.name,
      ...(Array.isArray(definition.capabilities) ? { capabilities: [...definition.capabilities] } : {}),
      ...(typeof definition.capabilities === 'function' ? { dynamic: true } : {}),
      approval: approvals[definition.name] ? 'interrupt' : options.permissions ? 'policy' : 'none',
    })),
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
    content: toolMessageContent(result),
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

/** What a middleware hook reads about its step, from the node it runs in. */
function hookContext(
  context: NodeContext<AgentChannels>,
  state: AgentState,
  store: Store | undefined,
): AgentMiddlewareContext {
  return {
    state,
    ...((context.store ?? store) ? { store: context.store ?? store } : {}),
    threadId: context.threadId,
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
    ...(context.principal ? { principal: context.principal } : {}),
    signal: context.signal,
    interrupt: <T>(request: InterruptRequest) => context.interrupt<T>(request),
  };
}

/** The answer `context.stop()` ends a run with: no model was called, so nothing was spent. */
function stopResponse(answer: string, model: string): NexusResponse {
  return {
    content: answer,
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: '',
      providerUsed: 'none',
      modelUsed: model,
      latencyMs: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensSaved: 0,
      cacheHit: false,
      guardrailsApplied: ['stopped-by-middleware'],
    },
  };
}

/**
 * Reads a streamed completion into a response, handing each piece of text to `onChunk` as it
 * arrives. Tool calls and the final metadata come from their own chunks.
 */
async function streamed(
  chunks: AsyncIterable<StreamChunk>,
  onChunk: (chunk: { kind: 'text' | 'reasoning'; content: string }) => void,
): Promise<NexusResponse> {
  let content = '';
  const toolCalls: ToolCall[] = [];
  let meta: Partial<ResponseMeta> = {};
  for await (const chunk of chunks) {
    if (chunk.type === 'text' && chunk.content) {
      content += chunk.content;
      onChunk({ kind: 'text', content: chunk.content });
    } else if (chunk.type === 'reasoning' && chunk.content) {
      onChunk({ kind: 'reasoning', content: chunk.content });
    } else if (chunk.type === 'tool_call' && chunk.toolCall) {
      toolCalls.push(chunk.toolCall);
    } else if (chunk.type === 'done') {
      meta = chunk.meta ?? meta;
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error ?? 'The model stream failed');
    }
  }
  return {
    content,
    role: 'assistant',
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    meta: meta as ResponseMeta,
  };
}
