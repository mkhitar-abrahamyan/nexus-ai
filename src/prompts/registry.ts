import type {
  PromptDefinition,
  PromptHistoryAction,
  PromptHistoryEntry,
  PromptLabel,
  PromptReference,
  PromptStore,
  PromptVariant,
  PromptVersion,
  RenderedPrompt,
  RenderOptions,
} from '../types/prompts.js';
import type { PromptDiff } from './diff.js';
import { type GateResult, PromptConflictError, PromptNotFoundError, PromptPromotionError } from './errors.js';
import { MemoryPromptStore } from './memory.js';
import { type CompiledPrompt, compilePrompt, renderCompiled } from './template.js';
import { chooseVariant } from './variant.js';
import { promptVersion } from './version.js';

/** What a promotion gate is asked to judge. */
export interface PromotionContext {
  /** The prompt. */
  name: string;
  /** The version being promoted. */
  version: PromptVersion;
  /** The label it is being promoted to. */
  to: string;
  /** The label it is being promoted from, when the promotion names one. */
  from?: string;
  /** The version `to` serves now, if any. */
  current?: PromptVersion;
  /** The registry, for gates that look things up. */
  registry: PromptRegistry;
}

/** Decides whether a version may be promoted to a label. */
export type PromotionGate = (context: PromotionContext) => Promise<GateResult> | GateResult;

/** A webhook notified when prompts change, signed as operation webhooks are. */
export interface PromptWebhookConfig {
  /** Where changes are posted. */
  url: string;
  /** Signs each delivery in the `x-nexus-signature` header. Verify with `verifyPromptWebhook()`. */
  secret: string;
  /** Changes delivered. Defaults to `promote`, `rollback`, and `split`. */
  actions?: readonly PromptHistoryAction[];
  /** Headers added to each delivery. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
  /** Gives up on a delivery after this long, in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
}

/** Options for a prompt registry. */
export interface PromptRegistryOptions {
  /** Where versions, labels, and history live. Defaults to a `MemoryPromptStore`. */
  store?: PromptStore;
  /** Gates run before a promotion, by the label promoted to, such as `{ production: [experimentGate(...)] }`. */
  gates?: Record<string, readonly PromotionGate[]>;
  /** Webhooks notified of changes. */
  webhooks?: readonly PromptWebhookConfig[];
  /** Called after every recorded change. */
  onChange?: (entry: PromptHistoryEntry) => void | Promise<void>;
  /** Receives webhook delivery failures, which never fail the change itself. */
  onWebhookError?: (error: unknown, entry: PromptHistoryEntry) => void;
  /** Compiled versions kept for rendering. Defaults to 256. */
  maxCompiled?: number;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** A version resolved for serving, with the reference recorded on requests rendered from it. */
export interface ResolvedPrompt {
  /** The version served. */
  version: PromptVersion;
  /** Name, version, label, and variant, as rendered requests record them. */
  reference: PromptReference;
}

/** The outcome of a promotion. */
export interface PromotionResult {
  /** The label after the promotion. */
  label: PromptLabel;
  /** Every gate's verdict. */
  results: GateResult[];
  /** False when the label already served the version, so nothing moved. */
  changed: boolean;
}

const VERSION_ID = /^p[0-9a-f]{12}$/;
const DEFAULT_WEBHOOK_ACTIONS: readonly PromptHistoryAction[] = ['promote', 'rollback', 'split'];

/**
 * Versions prompts and moves labels between them.
 *
 * `commit()` stores a definition under its content version, so committing unchanged content is a
 * no-op. Labels — `production`, `staging`, a tag — point at versions; `promote()` moves one after its
 * gates agree, `rollback()` moves it back, and `split()` shares its traffic between versions. Every
 * change is recorded, and the store is the only state, so any number of processes can share one.
 */
export class PromptRegistry {
  /** Where versions, labels, and history live. */
  readonly store: PromptStore;
  private readonly compiled = new Map<string, CompiledPrompt>();
  private readonly now: () => Date;

  constructor(private readonly options: PromptRegistryOptions = {}) {
    this.store = options.store ?? new MemoryPromptStore();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Commits a prompt and returns its version. Unchanged content returns the existing version and
   * records nothing; `label` points labels at the version either way.
   */
  async commit(
    prompt: PromptDefinition | { definition: PromptDefinition },
    options: { message?: string; author?: string; label?: string | readonly string[] } = {},
  ): Promise<PromptVersion> {
    const definition = 'definition' in prompt ? prompt.definition : prompt;
    const compiled = compilePrompt(definition);
    const id = await promptVersion(definition);
    let stored = await this.store.getVersion(definition.name, id);

    if (!stored) {
      const [newest] = await this.store.listVersions(definition.name, { limit: 1 });
      // Strictly after the newest version, so every store agrees on which is latest even when two
      // commits land in the same millisecond or a clock steps back.
      const now = this.now().getTime();
      const after = newest ? Date.parse(newest.createdAt) + 1 : Number.NEGATIVE_INFINITY;
      stored = {
        ...structuredClone(definition),
        version: id,
        variables: compiled.variables,
        createdAt: new Date(Math.max(now, after)).toISOString(),
        ...(options.message === undefined ? {} : { message: options.message }),
        ...(options.author === undefined ? {} : { author: options.author }),
        ...(newest ? { parent: newest.version } : {}),
      };
      await this.store.saveVersion(stored);
      this.remember(stored, compiled);
      await this.record({ name: definition.name, action: 'commit', version: id, by: options.author });
    }

    const labels = typeof options.label === 'string' ? [options.label] : (options.label ?? []);
    for (const label of labels) await this.label(definition.name, label, id, { by: options.author });
    return stored;
  }

  /**
   * A version by content version, label, or `latest`, the default. Throws `PromptNotFoundError` when
   * there is none. A split label resolves to its control arm; `resolve()` picks an arm.
   */
  async get(name: string, ref = 'latest'): Promise<PromptVersion> {
    if (ref === 'latest') {
      const [newest] = await this.store.listVersions(name, { limit: 1 });
      if (newest) return newest;
      throw new PromptNotFoundError(name, ref);
    }
    if (VERSION_ID.test(ref)) {
      const found = await this.store.getVersion(name, ref);
      if (found) return found;
    }
    const label = await this.store.getLabel(name, ref);
    const found = label ? await this.store.getVersion(name, label.version) : undefined;
    if (!found) throw new PromptNotFoundError(name, ref);
    return found;
  }

  /** Resolves a reference for serving, choosing an A/B arm by `key` when the label splits traffic. */
  async resolve(name: string, ref = 'latest', options: { key?: string } = {}): Promise<ResolvedPrompt> {
    if (ref !== 'latest' && !VERSION_ID.test(ref)) {
      const label = await this.store.getLabel(name, ref);
      if (!label) throw new PromptNotFoundError(name, ref);
      const variant = label.variants?.length
        ? chooseVariant(
            label.variants,
            options.key === undefined ? undefined : `${options.key}\u0000${name}\u0000${ref}`,
          )
        : undefined;
      const id =
        variant === undefined || !label.variants ? label.version : (label.variants[variant] as PromptVariant).version;
      const version = await this.store.getVersion(name, id);
      if (!version) throw new PromptNotFoundError(name, id);
      return { version, reference: { name, version: id, label: ref, ...(variant === undefined ? {} : { variant }) } };
    }
    const version = await this.get(name, ref);
    return { version, reference: { name, version: version.version } };
  }

  /** Renders a prompt by reference, recording the version, label, and arm in `metadata.prompt`. */
  async render(
    name: string,
    variables: Record<string, unknown> = {},
    options: RenderOptions & { ref?: string; key?: string } = {},
  ): Promise<RenderedPrompt> {
    const resolved = await this.resolve(name, options.ref, { key: options.key });
    return this.renderVersion(resolved, variables, options);
  }

  /** Renders a resolved version. Compilation is cached per version, since versions never change. */
  renderVersion(
    resolved: ResolvedPrompt,
    variables: Record<string, unknown> = {},
    options: RenderOptions = {},
  ): RenderedPrompt {
    const key = `${resolved.version.name}\u0000${resolved.version.version}`;
    let compiled = this.compiled.get(key);
    if (!compiled) {
      compiled = compilePrompt(resolved.version);
      this.remember(resolved.version, compiled);
    }
    return renderCompiled(compiled, resolved.version, variables, resolved.reference, options);
  }

  /** Points a label at a version, without gates. Throws `PromptConflictError` if the label moved meanwhile. */
  async label(
    name: string,
    label: string,
    ref: string,
    options: { by?: string; note?: string } = {},
  ): Promise<PromptLabel> {
    const version = await this.get(name, ref);
    const current = await this.store.getLabel(name, label);
    if (current?.version === version.version && !current.variants) return current;
    const next = this.pointer(name, label, version.version, options.by);
    if (!(await this.store.setLabel(next, current?.version ?? null))) throw new PromptConflictError(name, label);
    await this.record({
      name,
      action: 'label',
      label,
      version: version.version,
      previous: current?.version,
      ...options,
    });
    return next;
  }

  /** Removes a label. Resolves false when there was none. */
  async unlabel(name: string, label: string, options: { by?: string; note?: string } = {}): Promise<boolean> {
    const current = await this.store.getLabel(name, label);
    if (!current || !(await this.store.deleteLabel(name, label))) return false;
    await this.record({ name, action: 'unlabel', label, previous: current.version, ...options });
    return true;
  }

  /**
   * Moves `to` to a version — named directly, or whatever `from` serves — once every gate for `to`
   * allows it. Throws `PromptPromotionError` when a gate refuses, unless `force` is set, in which
   * case the refusals are still reported and recorded in the note.
   */
  async promote(
    name: string,
    options: { to: string; from?: string; version?: string; by?: string; note?: string; force?: boolean },
  ): Promise<PromotionResult> {
    const source = options.version ?? options.from;
    if (!source) throw new RangeError('promote() needs a version or a label to promote from');
    const version = await this.get(name, source);
    const currentLabel = await this.store.getLabel(name, options.to);
    if (currentLabel?.version === version.version && !currentLabel.variants) {
      return { label: currentLabel, results: [], changed: false };
    }
    const current = currentLabel ? await this.store.getVersion(name, currentLabel.version) : undefined;

    const results: GateResult[] = [];
    for (const gate of this.options.gates?.[options.to] ?? []) {
      results.push(await gate({ name, version, to: options.to, from: options.from, current, registry: this }));
    }
    const refused = results.filter((result) => !result.ok);
    if (refused.length > 0 && !options.force) throw new PromptPromotionError(name, options.to, results);

    const next = this.pointer(name, options.to, version.version, options.by);
    if (!(await this.store.setLabel(next, currentLabel?.version ?? null))) {
      throw new PromptConflictError(name, options.to);
    }
    const forced = refused.length > 0 ? `forced past ${refused.map((result) => result.gate).join(', ')}` : undefined;
    await this.record({
      name,
      action: 'promote',
      label: options.to,
      version: version.version,
      previous: currentLabel?.version,
      from: options.from,
      by: options.by,
      note: [options.note, forced].filter(Boolean).join('; ') || undefined,
    });
    return { label: next, results, changed: true };
  }

  /** Moves a label back to where it pointed before its last change. */
  async rollback(name: string, label: string, options: { by?: string; note?: string } = {}): Promise<PromptLabel> {
    const current = await this.store.getLabel(name, label);
    if (!current) throw new PromptNotFoundError(name, label);
    const [last] = (await this.store.listHistory(name, { label, limit: 20 })).filter(
      (entry) => entry.previous && entry.previous !== current.version,
    );
    if (!last?.previous) throw new PromptNotFoundError(name, `${label} (no earlier version to roll back to)`);
    const next = this.pointer(name, label, last.previous, options.by);
    if (!(await this.store.setLabel(next, current.version))) throw new PromptConflictError(name, label);
    await this.record({
      name,
      action: 'rollback',
      label,
      version: last.previous,
      previous: current.version,
      ...options,
    });
    return next;
  }

  /**
   * Splits a label's traffic between versions, for an A/B test. The first arm is the control, which
   * `get()` returns. Splits are not gated: split only between versions already fit to serve.
   */
  async split(
    name: string,
    label: string,
    arms: ReadonlyArray<{ ref: string; weight: number }>,
    options: { by?: string; note?: string } = {},
  ): Promise<PromptLabel> {
    if (arms.length === 0 || arms.some((arm) => !(arm.weight >= 0)) || !arms.some((arm) => arm.weight > 0)) {
      throw new RangeError('A split needs at least one arm and non-negative weights that are not all zero');
    }
    const variants: PromptVariant[] = [];
    for (const arm of arms) variants.push({ version: (await this.get(name, arm.ref)).version, weight: arm.weight });
    const current = await this.store.getLabel(name, label);
    const next = { ...this.pointer(name, label, (variants[0] as PromptVariant).version, options.by), variants };
    if (!(await this.store.setLabel(next, current?.version ?? null))) throw new PromptConflictError(name, label);
    await this.record({
      name,
      action: 'split',
      label,
      version: next.version,
      previous: current?.version,
      variants,
      ...options,
    });
    return next;
  }

  /** A prompt's history, newest first, optionally for one label. */
  async history(name: string, options: { label?: string; limit?: number } = {}): Promise<PromptHistoryEntry[]> {
    return this.store.listHistory(name, options);
  }

  /** Versions of a prompt, newest first. */
  async versions(name: string, options: { limit?: number } = {}): Promise<PromptVersion[]> {
    return this.store.listVersions(name, options);
  }

  /** Every label of a prompt. */
  async labels(name: string): Promise<PromptLabel[]> {
    return this.store.listLabels(name);
  }

  /** Every prompt name. */
  async names(): Promise<string[]> {
    return this.store.listNames();
  }

  /** What changed between two references: messages line by line, partials, configuration, and defaults. */
  async diff(name: string, from: string, to: string): Promise<PromptDiff> {
    const [{ diffPrompts }, a, b] = await Promise.all([import('./diff.js'), this.get(name, from), this.get(name, to)]);
    return diffPrompts(a, b);
  }

  private pointer(name: string, label: string, version: string, by?: string): PromptLabel {
    return { name, label, version, updatedAt: this.now().toISOString(), ...(by === undefined ? {} : { by }) };
  }

  private remember(version: PromptVersion, compiled: CompiledPrompt): void {
    const key = `${version.name}\u0000${version.version}`;
    this.compiled.delete(key);
    this.compiled.set(key, compiled);
    const max = this.options.maxCompiled ?? 256;
    while (this.compiled.size > max) this.compiled.delete(this.compiled.keys().next().value as string);
  }

  private async record(entry: Omit<PromptHistoryEntry, 'at'>): Promise<void> {
    const full = Object.fromEntries(
      Object.entries({ ...entry, at: this.now().toISOString() }).filter(([, value]) => value !== undefined),
    ) as unknown as PromptHistoryEntry;
    await this.store.appendHistory(full);
    await this.options.onChange?.(full);
    const webhooks = (this.options.webhooks ?? []).filter((hook) =>
      (hook.actions ?? DEFAULT_WEBHOOK_ACTIONS).includes(full.action),
    );
    if (webhooks.length === 0) return;
    const { deliverPromptWebhook } = await import('./webhooks.js');
    await Promise.all(
      webhooks.map((hook) =>
        deliverPromptWebhook(hook, full).catch((error: unknown) => this.options.onWebhookError?.(error, full)),
      ),
    );
  }
}
