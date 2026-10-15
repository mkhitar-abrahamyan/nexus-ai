/**
 * Helpers beside a deep agent: helpers it delegates to and waits for, helpers that run in the
 * background while it goes on, and helpers it creates during a run from instructions it writes.
 *
 * A background helper runs on a thread of its own, named after the call that started it, and writes
 * its checkpoints to the deep agent's checkpointer. A crash leaves the helper's finished steps behind
 * it: collecting the task in a new process carries the helper on from its last checkpoint, and a call
 * the agent repeats after the crash finds the same thread instead of starting the helper again.
 *
 * The helpers an agent creates are recorded on a thread of their own beside its own, before the call
 * that creates one returns, so an agent resumed in another process counts them against its `max` and
 * delegates to them again by name.
 */
import {
  type AgentGraph,
  type AgentState,
  agentInput,
  createAgent,
  type CreateAgentOptions,
} from '../agent/create-agent.js';
import type { PermissionPolicyLike } from '../agent/permissions.js';
import type { GraphCheckpointer, GraphEvent, GraphRunOptions } from '../types/graph.js';
import type { ToolContext, ToolDefinition } from '../types/messages.js';

/** Limits on the helpers a deep agent creates during a run, from instructions it writes. */
export interface DeepHelperLimits {
  /**
   * The tools a created helper may use, by name, from the agent's own. Defaults to all of them. A tool
   * that needs approval is never a helper's.
   */
  tools?: readonly string[];
  /** The model a created helper runs on. Defaults to the agent's. */
  model?: string;
  /** Model calls a created helper may make. Defaults to 10. */
  maxIterations?: number;
  /** How many helpers the agent may create in one thread. Defaults to 5. */
  max?: number;
}

/** A helper as `delegate` runs it: one the application declared, or one the agent created. */
interface HelperSpec {
  name: string;
  instructions: string;
  tools?: readonly string[];
  model?: string;
  maxIterations: number;
  created: boolean;
}

/** What the deep agent hands the helper tools. */
export interface HelperSetup {
  /** The helpers the application declared. */
  declared: ReadonlyArray<{
    name: string;
    description: string;
    instructions: string;
    tools?: readonly string[];
    model?: string;
    maxIterations?: number;
  }>;
  /** Limits on created helpers, when the agent may create them. */
  create?: DeepHelperLimits;
  /** The tools a helper may be given: the agent's own, less any that need approval. */
  tools: readonly ToolDefinition[];
  /** `createAgent()` options every helper shares. */
  agentOptions: Omit<CreateAgentOptions, 'interruptOn' | 'tools' | 'systemPrompt' | 'permissions' | 'checkpointer'>;
  /** The policy every helper runs under. */
  permissions?: PermissionPolicyLike;
  /** Where background helpers keep their checkpoints. */
  checkpointer?: GraphCheckpointer;
  /** The deep agent's name, for the helpers' names. */
  name: string;
  /** Appended to every helper's instructions. */
  note: string;
  /** How many helpers may run in the background in one thread at once. */
  maxBackground: number;
}

/** How a helper's task ended. */
type Outcome = { helper: string; ok: true; answer: string } | { helper: string; ok: false; error: string };

/** A background task running in this process. */
interface LiveTask {
  helper: string;
  outcome: Promise<Outcome>;
  settled: boolean;
}

const MARK = 'deepAgentHelper';
/** Where a thread's created helpers are recorded: in the metadata of a checkpoint on a thread of their own. */
const CREATED = 'deepAgentCreatedHelpers';

/** A created helper as its record keeps it. */
interface CreatedRecord {
  name: string;
  instructions: string;
  tools?: readonly string[];
  model?: string;
  maxIterations: number;
}

/** `delegate` and `collect_helper`, sharing the helpers they run. */
export function helperTools(setup: HelperSetup): ToolDefinition[] {
  const declared = new Map(setup.declared.map((helper) => [helper.name, helper]));
  const created = new Map<string, Map<string, HelperSpec>>();
  const graphs = new Map<string, AgentGraph>();
  const live = new Map<string, LiveTask>();
  // Each thread's record is read once per process, before its first created helper is looked up.
  const recorded = new Map<string, Promise<void>>();
  const createdThread = (thread: string) => `${thread || 'thread'}/helpers-created`;

  const loadCreated = (thread: string): Promise<void> => {
    const checkpointer = setup.checkpointer;
    if (!checkpointer || !setup.create) return Promise.resolve();
    let loading = recorded.get(thread);
    if (!loading) {
      loading = (async () => {
        const stored = await checkpointer.get(createdThread(thread));
        const records = (stored?.metadata?.[CREATED] ?? []) as CreatedRecord[];
        const mine = created.get(thread) ?? new Map<string, HelperSpec>();
        for (const record of records) {
          if (!mine.has(record.name)) mine.set(record.name, { ...record, created: true });
        }
        created.set(thread, mine);
      })();
      // A failed read is tried again on the next lookup rather than remembered.
      loading.catch(() => recorded.delete(thread));
      recorded.set(thread, loading);
    }
    return loading;
  };

  // Written before the call that created the helper returns: from then on, a resumed agent counts it.
  const recordCreated = async (thread: string, mine: Map<string, HelperSpec>): Promise<void> => {
    const checkpointer = setup.checkpointer;
    if (!checkpointer) return;
    const threadId = createdThread(thread);
    const records: CreatedRecord[] = [...mine.values()].map(({ created: _created, ...record }) => record);
    await checkpointer.put({
      version: 2,
      id: `${threadId}:${records.length}`,
      threadId,
      step: records.length,
      state: {},
      next: [],
      tasks: [],
      status: 'completed',
      interrupts: [],
      createdAt: new Date().toISOString(),
      metadata: { [CREATED]: records },
    });
  };

  const spec = async (name: string, instructions: string | undefined, thread: string): Promise<HelperSpec> => {
    const helper = declared.get(name);
    if (helper) {
      return {
        name,
        instructions: helper.instructions,
        ...(helper.tools ? { tools: helper.tools } : {}),
        ...(helper.model ? { model: helper.model } : {}),
        maxIterations: helper.maxIterations ?? 20,
        created: false,
      };
    }
    await loadCreated(thread);
    const mine = created.get(thread) ?? new Map<string, HelperSpec>();
    const existing = mine.get(name);
    if (existing) return existing;
    const known = [...declared.keys(), ...mine.keys()].join(', ') || 'none';
    if (!setup.create) throw new Error(`No helper named "${name}"; the helpers are ${known}`);
    if (!/^[A-Za-z][\w-]{0,39}$/.test(name)) {
      throw new Error('A new helper needs a name of letters, digits, _ and -, starting with a letter');
    }
    if (!instructions?.trim()) throw new Error(`To create the helper "${name}", give its instructions`);
    const max = setup.create.max ?? 5;
    if (mine.size >= max) throw new Error(`This thread has created its ${max} helpers; delegate to one of: ${known}`);
    const made: HelperSpec = {
      name,
      instructions: instructions.trim(),
      ...(setup.create.tools ? { tools: setup.create.tools } : {}),
      ...(setup.create.model ? { model: setup.create.model } : {}),
      maxIterations: setup.create.maxIterations ?? 10,
      created: true,
    };
    mine.set(name, made);
    created.set(thread, mine);
    try {
      await recordCreated(thread, mine);
    } catch (error) {
      // Not recorded means not created: a resumed agent could not count it, so it may not be used.
      mine.delete(name);
      throw error;
    }
    return made;
  };

  const graph = (helper: HelperSpec, durable: boolean): AgentGraph => {
    const key = JSON.stringify([helper.name, helper.created ? helper.instructions : '', durable]);
    const cached = graphs.get(key);
    if (cached) return cached;
    const allowed = helper.tools ? new Set(helper.tools) : undefined;
    const made = createAgent({
      ...setup.agentOptions,
      name: `${setup.name}.${helper.name}`,
      ...(helper.model ? { model: helper.model } : {}),
      maxIterations: helper.maxIterations,
      systemPrompt: `${helper.instructions}\n\n${setup.note}`,
      tools: setup.tools.filter((candidate) => (allowed ? allowed.has(candidate.name) : true)),
      ...(setup.permissions ? { permissions: setup.permissions } : {}),
      // A helper the agent waits for works in a fresh context and keeps nothing; one in the background
      // keeps checkpoints, so a crash does not repeat its finished steps.
      checkpointer: durable && setup.checkpointer ? setup.checkpointer : false,
    });
    graphs.set(key, made);
    return made;
  };

  // The helper runs for the same caller as the agent, and its events reach the agent's stream under
  // the helper's own namespace.
  const runOptions = (context: ToolContext, namespace: string, extra: GraphRunOptions = {}): GraphRunOptions => {
    const forward = context.forward;
    const onEvent = extra.onEvent;
    return {
      ...extra,
      ...(context.principal ? { principal: context.principal } : {}),
      ...(forward || onEvent
        ? {
            subgraphEvents: Boolean(forward),
            onEvent: (event: GraphEvent) => {
              onEvent?.(event);
              forward?.(event, [namespace]);
            },
          }
        : {}),
    };
  };

  const outcome = (helper: string, ended: { status: string; state: AgentState; error?: unknown } | undefined) => {
    if (ended?.status === 'completed') {
      return {
        helper,
        ok: true as const,
        answer: ended.state.answer || `The ${helper} helper finished without an answer (${ended.state.stopReason}).`,
      };
    }
    const why = ended?.error ? ((ended.error as { message?: string }).message ?? String(ended.error)) : ended?.status;
    return { helper, ok: false as const, error: `The ${helper} helper stopped: ${why ?? 'it did not run'}` };
  };

  const thread = (parent: string | undefined, task: string) => `${parent ?? 'thread'}/helper/${task}`;

  // Starts a background task, or carries on one a stopped process left behind. It returns once the
  // task's first checkpoint is written, so the task outlives a crash from then on.
  const start = async (helper: HelperSpec, task: string | undefined, threadId: string, context: ToolContext) => {
    if (live.has(threadId)) return;
    const runner = graph(helper, true);
    const stored = setup.checkpointer ? await runner.state(threadId) : undefined;
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const options = runOptions(context, threadId.slice(threadId.lastIndexOf('/') + 1), {
      threadId,
      metadata: {
        [MARK]: {
          name: helper.name,
          created: helper.created,
          ...(helper.created ? { instructions: helper.instructions } : {}),
        },
      },
      onEvent: (event) => {
        if (event.type === 'checkpoint') ready();
      },
    });
    const steps =
      stored === undefined
        ? runner.stream(agentInput(task ?? ''), options)
        : stored.status === 'completed' || stored.status === 'failed'
          ? undefined
          : runner.continue(threadId, options);
    const drive = async (): Promise<Outcome> => {
      let last: { status: string; state: AgentState } | undefined;
      if (steps) for await (const step of steps) last = step;
      return outcome(helper.name, (setup.checkpointer ? await runner.state(threadId) : undefined) ?? last ?? stored);
    };
    const entry: LiveTask = { helper: helper.name, settled: false, outcome: Promise.resolve(undefined as never) };
    entry.outcome = drive()
      .catch((error: unknown) => ({
        helper: helper.name,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        entry.settled = true;
        ready();
      });
    live.set(threadId, entry);
    await started;
  };

  const names = [...declared.keys()];
  const delegate: ToolDefinition = {
    name: 'delegate',
    description: [
      'Hands a self-contained task to a helper, which works in a fresh context and returns its answer.',
      'With background, the helper works while you go on: you get a task id at once, and collect_helper returns its answer.',
      ...(setup.create ? ['To create a helper for a task no helper fits, give a new name and its instructions.'] : []),
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        agent: setup.create
          ? { type: 'string', description: `A helper (${names.join(', ') || 'none yet'}), or a new name to create one` }
          : { type: 'string', enum: names },
        task: { type: 'string', description: 'Everything the helper needs to know: it sees nothing else.' },
        ...(setup.create
          ? { instructions: { type: 'string', description: 'For a new helper: who it is and how it works.' } }
          : {}),
        background: { type: 'boolean', description: 'Runs the helper while you go on.' },
      },
      required: ['agent', 'task'],
    },
    capabilities: [],
    execute: async (args, context = {}) => {
      const helper = await spec(
        String(args.agent ?? ''),
        typeof args.instructions === 'string' ? args.instructions : undefined,
        context.threadId ?? '',
      );
      const task = String(args.task ?? '');
      const call = context.toolCallId ?? Math.random().toString(36).slice(2, 10);
      if (args.background !== true) {
        const result = await graph(helper, false).invoke(
          agentInput(task),
          runOptions(context, `${helper.name}@${call}`, context.signal ? { signal: context.signal } : {}),
        );
        return (
          result.state.answer || `The ${helper.name} helper finished without an answer (${result.state.stopReason}).`
        );
      }
      const running = [...live.entries()].filter(
        ([id, entry]) => id.startsWith(thread(context.threadId, '')) && !entry.settled,
      ).length;
      if (running >= setup.maxBackground) {
        throw new Error(
          `${running} helpers are already working in the background; collect one with collect_helper first`,
        );
      }
      const id = `${helper.name}@${call}`;
      await start(helper, task, thread(context.threadId, id), context);
      return `The ${helper.name} helper is working in the background as task ${id}. Collect its answer with collect_helper.`;
    },
  };

  const collect: ToolDefinition = {
    name: 'collect_helper',
    description:
      'Returns the answer of a helper working in the background, by its task id, waiting up to wait_seconds for it. Without a task, lists the tasks of this run.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task id delegate returned' },
        wait_seconds: { type: 'number', description: 'How long to wait for the answer, up to 120. Defaults to 0.' },
      },
    },
    capabilities: [],
    execute: async (args, context = {}) => {
      const prefix = thread(context.threadId, '');
      if (typeof args.task !== 'string' || !args.task) {
        const tasks = [...live.entries()].filter(([id]) => id.startsWith(prefix));
        if (tasks.length === 0) return 'No helper is working in the background in this process.';
        return tasks
          .map(([id, entry]) => `${id.slice(prefix.length)}: ${entry.settled ? 'finished' : 'working'}`)
          .join('\n');
      }
      const task = args.task;
      const threadId = thread(context.threadId, task);
      if (!live.has(threadId)) {
        // Not running here: it finished, or a process that ran it stopped before it did.
        const stored = setup.checkpointer ? await setup.checkpointer.get(threadId) : undefined;
        if (!stored) throw new Error(`No helper task "${task}" in this run`);
        const mark = stored.metadata?.[MARK] as { name?: string; created?: boolean; instructions?: string } | undefined;
        const name = mark?.name ?? task.slice(0, task.lastIndexOf('@'));
        const helper = mark?.created
          ? await spec(name, mark.instructions, context.threadId ?? '')
          : await spec(name, undefined, context.threadId ?? '');
        await start(helper, undefined, threadId, context);
      }
      const entry = live.get(threadId) as LiveTask;
      const waitMs = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 120) * 1_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([
        entry.outcome,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), waitMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!ended) return `The ${entry.helper} helper is still working on task ${task}. Collect it again later.`;
      if (!ended.ok) throw new Error(ended.error);
      return `The ${ended.helper} helper's answer: ${ended.answer}`;
    },
  };

  return [delegate, collect];
}
