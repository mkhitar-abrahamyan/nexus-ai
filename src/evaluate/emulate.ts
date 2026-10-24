/**
 * Tools emulated by a model, for evaluations that must not touch the world: an agent that would
 * charge a card or write to a production database runs against a model playing each tool instead,
 * with nothing sent, and the emulator's answers recorded so a run replays them exactly.
 */
import { capabilitiesOf, parseCapability } from '../agent/capabilities.js';
import type { CompletionRequest, Message, ToolContext, ToolDefinition } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { sha256Hex } from '../utils/sha256.js';

/** The model that plays the tools: the client, or anything with its `complete()`. */
export interface EmulatorClient {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

/** One call to an emulated or passed-through tool, as `onCall` reports it. */
export interface EmulatedToolCall {
  /** The tool's name. */
  tool: string;
  /** The arguments the agent called it with. */
  args: Record<string, unknown>;
  /** What it returned, when it did not fail. */
  result?: unknown;
  /** The error it failed with, when it did. */
  error?: string;
  /** Who answered: the emulating model, the store, replaying an earlier answer, or the real tool. */
  source: 'model' | 'store' | 'real';
  /** The call's key in the store. */
  key: string;
}

/** An emulated answer, as a store keeps it. */
export interface EmulatedResult {
  /** The tool's name. */
  tool: string;
  /** The arguments it was called with. */
  args: Record<string, unknown>;
  /** What it returned. */
  result?: unknown;
  /** The error it failed with. */
  error?: string;
}

/** Where emulated answers are kept, by `emulationKey()`, so a later run replays them. */
export interface EmulationStore {
  /** The answer kept for a key. */
  get(key: string): Promise<EmulatedResult | undefined> | EmulatedResult | undefined;
  /** Keeps an answer. */
  set(key: string, value: EmulatedResult): Promise<void> | void;
}

/** Options for `emulatedTools()`. */
export interface EmulatedToolsOptions {
  /** The model that plays each tool. */
  client: EmulatorClient;
  /** The model to ask. Defaults to `auto`, the client's routing. */
  model?: string;
  /**
   * The world the tools act on, as the emulator reads it, such as `Order 1042 was delivered on
   * 3 October and cost $59.` Part of each call's key, so one store holds answers for many scenarios.
   */
  scenario?: string;
  /** Each tool's own notes, by name: what it returns, when it fails, and its rules. */
  instructions?: Readonly<Record<string, string>>;
  /** Real calls to imitate, by tool: their arguments and what the real tool returned. */
  examples?: Readonly<Record<string, ReadonlyArray<{ args: Record<string, unknown>; result: unknown }>>>;
  /** JSON Schema of each tool's result, by name, shown to the emulator. */
  results?: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * Checks each tool's emulated result, by name: `true`, or why not. A result that fails is asked
   * for again once, with the reason, and then fails the call with an `EmulationError`.
   */
  validate?: Readonly<Record<string, (result: unknown) => true | string>>;
  /** Tools that run for real, by name: ones that read and change nothing. Defaults to none. */
  passthrough?: readonly string[];
  /** Where answers are kept and replayed from. */
  store?: EmulationStore;
  /**
   * `auto`, the default with a store, replays a kept answer and asks the model for the rest, keeping
   * them; `replay` answers only from the store, failing a call it has no answer for; `record` asks the
   * model every time and keeps each answer; `emulate`, the default without a store, asks the model.
   */
  mode?: 'auto' | 'replay' | 'record' | 'emulate';
  /**
   * How many earlier calls of this set the emulator sees, so a refund it reported shows when the
   * order is looked up again. Defaults to 20; 0 shows none.
   */
  history?: number;
  /** Sampling temperature for the emulator. Defaults to 0. */
  temperature?: number;
  /** Longest answer, in tokens. */
  maxTokens?: number;
  /** Called after each call, with who answered it. */
  onCall?: (call: EmulatedToolCall) => void;
  /**
   * The world the tools act in, held across every run that shares it: each call made in it, and the
   * changes they made, so an order one example refunds is refunded for the next. The emulator is
   * told every change, and the latest `history` calls; its scenario is the tools' when they name
   * none. Share one world among runs made one at a time, in order; or start each run from a
   * `fork()`, or from a `snapshot()` read back.
   */
  world?: EmulatedWorld;
  /**
   * Tools that change nothing, by name, beside those whose every capability reads: `filesystem:read`,
   * `mcp.read`, or `api.read`, or none at all. A world counts what any other tool did, when it did
   * not fail, as a change.
   */
  reads?: readonly string[];
}

/** One call made in an emulated world. */
export interface EmulatedWorldCall extends EmulatedResult {
  /** Whether it changed the world: it succeeded, and its tool does more than read. */
  changed: boolean;
}

/** An emulated world as plain JSON, to write to a file and start runs from. */
export interface EmulatedWorldSnapshot {
  /** The world the tools act on, before any call. */
  scenario?: string;
  /** Every call made in it, oldest first. */
  calls: EmulatedWorldCall[];
}

/**
 * A world emulated tools act in, kept across the runs of an evaluation: the scenario it started
 * from, and every call made in it, so what one run changes is there for the next, as on a staging
 * copy of a service. `snapshot()` writes it as JSON, `new EmulatedWorld(snapshot)` reads it back,
 * and `fork()` starts a world from this one's present whose changes stay its own.
 *
 * ```ts
 * const world = new EmulatedWorld({ scenario: 'Order 1042 is delivered and cost $59.' });
 * await evaluate(
 *   (inputs) => agentOver(emulatedTools(shop.tools, { client: ai, results: shop.results, world })).invoke(agentInput(inputs.request)),
 *   dataset,
 *   evaluators,
 *   { concurrency: 1 },
 * );
 * ```
 */
export class EmulatedWorld {
  /** The world the tools act on, before any call. */
  readonly scenario?: string;
  private readonly log: EmulatedWorldCall[];

  constructor(start: { scenario?: string; calls?: readonly EmulatedWorldCall[] } = {}) {
    if (start.scenario !== undefined) this.scenario = start.scenario;
    this.log = JSON.parse(JSON.stringify(start.calls ?? [])) as EmulatedWorldCall[];
  }

  /** Every call made in it, oldest first. */
  get calls(): readonly EmulatedWorldCall[] {
    // Copies, so what it gives out cannot change it.
    return JSON.parse(JSON.stringify(this.log)) as EmulatedWorldCall[];
  }

  /** The calls that changed it, oldest first. */
  get changes(): readonly EmulatedWorldCall[] {
    return JSON.parse(JSON.stringify(this.log.filter((call) => call.changed))) as EmulatedWorldCall[];
  }

  /** Records a call made in it, and whether it changed it. */
  record(call: EmulatedResult, changed: boolean): void {
    this.log.push({ ...(JSON.parse(JSON.stringify(call)) as EmulatedResult), changed });
  }

  /**
   * A digest of its scenario and every change made in it, which the keys of its calls' answers carry:
   * two worlds that started alike and changed alike have the same digest, however much was read.
   */
  digest(): string {
    return sha256Hex(
      canonical({
        scenario: this.scenario ?? '',
        changes: this.changes.map((call) => ({ tool: call.tool, args: call.args, result: call.result ?? null })),
      }),
    );
  }

  /** How many calls with these arguments it has seen since its last change. */
  ordinal(tool: string, args: Record<string, unknown>): number {
    const identity = canonical(args);
    let count = 0;
    for (let index = this.log.length - 1; index >= 0; index -= 1) {
      const call = this.log[index] as EmulatedWorldCall;
      if (call.changed) break;
      if (call.tool === tool && canonical(call.args) === identity) count += 1;
    }
    return count;
  }

  /** It as plain JSON, to write to a file and start runs from. */
  snapshot(): EmulatedWorldSnapshot {
    return {
      ...(this.scenario !== undefined ? { scenario: this.scenario } : {}),
      calls: JSON.parse(JSON.stringify(this.log)) as EmulatedWorldCall[],
    };
  }

  /** A world starting from this one's present, whose changes stay its own. */
  fork(): EmulatedWorld {
    return new EmulatedWorld(this.snapshot());
  }

  /** The same as `snapshot()`, so `JSON.stringify(world)` writes it. */
  toJSON(): EmulatedWorldSnapshot {
    return this.snapshot();
  }
}

/** Raised when a call cannot be emulated: no kept answer in `replay`, or no valid answer from the model. */
export class EmulationError extends Error {
  constructor(
    /** `EMULATION_MISS` when the store has no answer, `EMULATION_INVALID` when the model gave none usable. */
    readonly code: 'EMULATION_MISS' | 'EMULATION_INVALID',
    /** The tool. */
    readonly tool: string,
    /** The arguments. */
    readonly args: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.name = 'EmulationError';
  }
}

/** Emulated answers in memory, from an earlier run's `toJSON()` when given one. */
export class MemoryEmulationStore implements EmulationStore {
  private readonly entries: Map<string, EmulatedResult>;

  constructor(entries: Readonly<Record<string, EmulatedResult>> = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  /** The answer kept for a key. */
  get(key: string): EmulatedResult | undefined {
    return this.entries.get(key);
  }

  /** Keeps an answer, replacing the one kept for its key. */
  set(key: string, value: EmulatedResult): void {
    this.entries.set(key, value);
  }

  /** How many answers it keeps. */
  get size(): number {
    return this.entries.size;
  }

  /** Every answer, by key, to write to a file the next run reads back. */
  toJSON(): Record<string, EmulatedResult> {
    return Object.fromEntries(this.entries);
  }
}

/**
 * The key of a call: its tool, its arguments, its scenario, and which call with those arguments it
 * is, so an order looked up before and after a refund keeps both answers. In a world, also the
 * world's `digest()`, so the same call answers again only after the same changes.
 */
export function emulationKey(call: {
  tool: string;
  args: Record<string, unknown>;
  scenario?: string;
  ordinal?: number;
  world?: string;
}): string {
  return sha256Hex(
    canonical({
      tool: call.tool,
      args: call.args,
      scenario: call.scenario ?? '',
      ordinal: call.ordinal ?? 0,
      // Absent without a world, so every answer kept before worlds keeps its key.
      ...(call.world !== undefined ? { world: call.world } : {}),
    }),
  );
}

/**
 * Whether a call changes nothing: its tool is named in `reads`, declares no capability, or declares
 * only reads. `network` beside a read is how the read is made, as an API's or an MCP server's tool
 * declares it; alone, it says nothing of what the call does, so it counts as a change.
 */
function onlyReads(definition: ToolDefinition, args: Record<string, unknown>, reads: ReadonlySet<string>): boolean {
  if (reads.has(definition.name)) return true;
  const declared = capabilitiesOf(definition, args);
  if (declared === undefined) return false;
  const parsed = declared.map((capability) => parseCapability(capability));
  const isRead = (item: ReturnType<typeof parseCapability>) =>
    (item.kind === 'filesystem' && item.access === 'read') || item.kind === 'mcp.read' || item.kind === 'api.read';
  return (
    parsed.every((item) => isRead(item) || item.kind === 'network') && (parsed.length === 0 || parsed.some(isRead))
  );
}

/**
 * Tools that look the same to the agent, by name, description, parameters, and capabilities, but are
 * answered by a model playing each one, or by the answers a store kept, and never run: nothing they
 * would send is sent. Tools in `passthrough` run for real. A tool the emulator says fails throws its
 * error, so the agent sees a failure as it would from the real tool.
 *
 * ```ts
 * const tools = emulatedTools([chargeCard, lookupOrder], { client: ai, model: 'gpt-5-mini', scenario, store });
 * const agent = createAgent({ client: ai, model: 'gpt-5', tools });
 * ```
 */
export function emulatedTools(tools: readonly ToolDefinition[], options: EmulatedToolsOptions): ToolDefinition[] {
  const mode = options.mode ?? (options.store ? 'auto' : 'emulate');
  if (mode !== 'emulate' && !options.store) throw new TypeError(`Emulation mode "${mode}" needs a store`);
  const passthrough = new Set(options.passthrough ?? []);
  const limit = Math.max(0, options.history ?? 20);
  const history: EmulatedResult[] = [];
  const ordinals = new Map<string, number>();
  const world = options.world;
  const reads = new Set(options.reads ?? []);
  const scenario = options.scenario ?? world?.scenario;
  const told: EmulatedToolsOptions = scenario === options.scenario ? options : { ...options, scenario };
  const report = (call: EmulatedToolCall) => {
    try {
      options.onCall?.(call);
    } catch {
      // Observing never fails the call.
    }
  };
  /** What the emulator is shown: in a world, every change and the latest calls; otherwise this set's latest calls. */
  const earlier = (): readonly EmulatedResult[] => {
    if (!world) return limit === 0 ? [] : history.slice(-limit);
    const calls = world.calls;
    return calls
      .filter((call, index) => call.changed || index >= calls.length - limit)
      .map(({ changed: _changed, ...call }) => call);
  };
  const remember = (definition: ToolDefinition, answer: EmulatedResult) => {
    history.push(answer);
    world?.record(answer, answer.error === undefined && !onlyReads(definition, answer.args, reads));
  };

  return tools.map((definition): ToolDefinition => {
    const { execute: run, stream, ...shape } = definition;
    if (passthrough.has(definition.name)) {
      if (!run && !stream) return definition;
      return {
        ...shape,
        // The real tool, observed: its progress still reaches the agent.
        execute: async (args: Record<string, unknown>, context?: ToolContext) => {
          const key = emulationKey({
            tool: definition.name,
            args,
            scenario,
            ...(world ? { world: world.digest() } : {}),
          });
          try {
            const result = run ? await run(args, context) : await drain(definition, args, context);
            remember(definition, { tool: definition.name, args, result });
            report({ tool: definition.name, args, result, source: 'real', key });
            return result;
          } catch (error) {
            remember(definition, { tool: definition.name, args, error: messageOf(error) });
            report({ tool: definition.name, args, error: messageOf(error), source: 'real', key });
            throw error;
          }
        },
      };
    }
    return {
      ...shape,
      execute: async (args: Record<string, unknown>, context?: ToolContext) => {
        let ordinal: number;
        if (world) {
          // In a world, counted since its last change, so a world read back from a snapshot keys alike.
          ordinal = world.ordinal(definition.name, args);
        } else {
          const identity = `${definition.name}\u0000${canonical(args)}`;
          ordinal = ordinals.get(identity) ?? 0;
          ordinals.set(identity, ordinal + 1);
        }
        const key = emulationKey({
          tool: definition.name,
          args,
          scenario,
          ordinal,
          ...(world ? { world: world.digest() } : {}),
        });

        let answer: EmulatedResult | undefined;
        let source: EmulatedToolCall['source'] = 'store';
        if (mode === 'auto' || mode === 'replay') answer = await options.store?.get(key);
        if (!answer) {
          if (mode === 'replay') {
            throw new EmulationError(
              'EMULATION_MISS',
              definition.name,
              args,
              `No kept answer for ${definition.name}(${canonical(args)}), call ${ordinal + 1}: record it first`,
            );
          }
          answer = await emulate(definition, args, context, earlier(), told, world !== undefined);
          source = 'model';
          if (mode !== 'emulate') await options.store?.set(key, answer);
        }
        remember(definition, answer);
        report({
          tool: definition.name,
          args,
          ...(answer.error === undefined ? { result: answer.result } : { error: answer.error }),
          source,
          key,
        });
        if (answer.error !== undefined) throw new Error(answer.error);
        return answer.result;
      },
    };
  });
}

/** Asks the emulator for one call's answer, once more with the reason when the first is not usable. */
async function emulate(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolContext | undefined,
  earlier: readonly EmulatedResult[],
  options: EmulatedToolsOptions,
  inWorld: boolean,
): Promise<EmulatedResult> {
  const messages: Message[] = [
    { role: 'system', content: brief(definition, earlier, options, inWorld) },
    { role: 'user', content: `Arguments: ${JSON.stringify(args)}` },
  ];
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await options.client.complete({
      model: options.model ?? 'auto',
      messages: [...messages],
      responseFormat: { type: 'json' },
      temperature: options.temperature ?? 0,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
      ...(context?.tenantId ? { tenantId: context.tenantId } : {}),
      metadata: { emulatedTool: definition.name },
    });
    const text = typeof response.content === 'string' ? response.content : '';
    const parsed = parseAnswer(text);
    if (parsed === undefined) problem = 'The answer was not JSON. Reply with JSON only.';
    else if ('error' in parsed) return { tool: definition.name, args, error: parsed.error };
    else {
      const verdict = options.validate?.[definition.name]?.(parsed.result) ?? true;
      if (verdict === true) return { tool: definition.name, args, result: parsed.result };
      problem = `The result does not fit what ${definition.name} returns: ${verdict}. Answer again.`;
    }
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: problem });
  }
  throw new EmulationError(
    'EMULATION_INVALID',
    definition.name,
    args,
    `The emulator gave no usable answer for ${definition.name}: ${problem}`,
  );
}

/**
 * What the emulator is told: the tool, its notes, the scenario, real calls, and this run's earlier
 * calls, or, in a world, what has happened in it.
 */
function brief(
  definition: ToolDefinition,
  earlier: readonly EmulatedResult[],
  options: EmulatedToolsOptions,
  inWorld: boolean,
): string {
  const lines = [
    `You are emulating the tool "${definition.name}" for a test, in place of the real one.`,
    'Reply with exactly what the real tool would return for the arguments you are given, as JSON:',
    '{"result": <what it returns>}, or, when the real tool would fail, {"error": "<its error message>"}.',
    'Never explain. Stay consistent with the scenario, the examples, and the earlier calls.',
    '',
    `Tool: ${definition.name}`,
    `Description: ${definition.description}`,
    `Arguments schema: ${JSON.stringify(definition.parameters)}`,
  ];
  const result = options.results?.[definition.name];
  if (result) lines.push(`Result schema: ${JSON.stringify(result)}`);
  const notes = options.instructions?.[definition.name];
  if (notes) lines.push(`Notes: ${notes}`);
  if (options.scenario) lines.push('', `Scenario: ${options.scenario}`);
  const examples = options.examples?.[definition.name] ?? [];
  if (examples.length > 0) {
    lines.push('', 'Real calls of this tool:');
    for (const example of examples) {
      lines.push(`- arguments ${JSON.stringify(example.args)} returned ${JSON.stringify(example.result)}`);
    }
  }
  if (earlier.length > 0) {
    lines.push(
      '',
      inWorld
        ? 'What has happened in this world, oldest first: every change made in it, and the latest calls. Answer as the world now is.'
        : 'Earlier calls in this run, oldest first:',
    );
    for (const call of earlier) {
      const outcome = call.error === undefined ? `returned ${JSON.stringify(call.result)}` : `failed: ${call.error}`;
      lines.push(`- ${call.tool} ${JSON.stringify(call.args)} ${outcome}`);
    }
  }
  return lines.join('\n');
}

/** The emulator's answer: `{ result }`, `{ error }`, or any other JSON as the result; `undefined` when not JSON. */
function parseAnswer(text: string): { result: unknown } | { error: string } | undefined {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === 'error' && typeof record.error === 'string') return { error: record.error };
    if (keys.length === 1 && keys[0] === 'result') return { result: record.result };
  }
  return { result: value };
}

async function drain(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<unknown> {
  const generator = (definition.stream as NonNullable<ToolDefinition['stream']>)(args, context);
  for (;;) {
    const step = await generator.next();
    if (step.done) return step.value;
    context?.progress?.(step.value);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON with every object's keys in order. */
function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, (item as Record<string, unknown>)[key]]),
          )
        : item,
    ) ?? 'undefined'
  );
}
