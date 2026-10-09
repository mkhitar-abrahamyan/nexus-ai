import type { GateResult } from '../prompts/errors.js';
import { MemoryPromptStore } from '../prompts/memory.js';
import type { PromptRegistry } from '../prompts/registry.js';
import { canonicalJson } from '../prompts/version.js';
import type {
  PromptHistoryEntry,
  PromptLabel,
  PromptStore,
  PromptVersion,
  RenderedPrompt,
  RenderOptions,
} from '../types/prompts.js';
import { type ContextDiff, diffContexts } from './diff.js';
import {
  type ContextKeyring,
  type ContextSignature,
  type ContextSignedContent,
  type ContextSigner,
  contextDigest,
  signDigest,
  verifiedBy,
} from './signing.js';

/** A prompt a bundle uses, pinned to one content version of the prompt registry. */
export interface ContextPromptPin {
  /** The prompt's name in the registry. */
  name: string;
  /** Its content version, such as `p3f9a1c02b7de`. */
  version: string;
}

/** A tool a bundle offers: its name, description, and argument schema. The implementation stays in code. */
export interface ContextTool {
  /** The tool's name, as the model sees it. */
  name: string;
  /** What the tool does, for the model. */
  description?: string;
  /** JSON Schema for its arguments. */
  parameters?: Record<string, unknown>;
}

/** A skill: instructions for one kind of task, with the reference material it needs. */
export interface ContextSkill {
  /** When the skill applies, so an agent or a router can choose it. */
  description: string;
  /** How to do the task. */
  instructions: string;
  /** Reference material by name, such as a style guide or a schema. */
  resources?: Record<string, string>;
}

/**
 * Everything an agent runs with, versioned together: pinned prompts, named instructions, tool
 * definitions, skills, and configuration. A change to any part is a new version of the whole.
 */
export interface ContextBundleDefinition {
  /** The bundle's name, such as `support-agent`. */
  name: string;
  /** What the bundle is for. */
  description?: string;
  /** Prompts by role, such as `{ answer: { name: 'support-answer', version: 'p…' } }`. */
  prompts?: Record<string, ContextPromptPin>;
  /** Named instructions, such as a system policy or a tone guide. */
  instructions?: Record<string, string>;
  /** The tools the agent is offered. */
  tools?: ContextTool[];
  /** Skills by name. */
  skills?: Record<string, ContextSkill>;
  /** Settings the application reads, such as a model or a temperature. */
  config?: Record<string, unknown>;
  /** Application data. Not part of the version, so describing a bundle differently does not change it. */
  metadata?: Record<string, unknown>;
}

/** A committed bundle version. */
export interface ContextBundle extends ContextBundleDefinition {
  /** Its content version: `c` and 12 hex digits of a SHA-256 over everything but `metadata`. */
  version: string;
  /** ISO-8601 time it was committed. */
  createdAt: string;
  /** Why it changed, from the commit. */
  message?: string;
  /** Who committed it. */
  author?: string;
  /** The version that was newest before it. */
  parent?: string;
  /** Signatures over its content and its pinned prompts' content. Not part of the version. */
  signatures?: ContextSignature[];
}

/** Which bundle version is being used, as experiments and traces record it. */
export interface ContextReference {
  /** The bundle's name. */
  name: string;
  /** Its content version. */
  version: string;
  /** The label it was resolved through, when it was. */
  label?: string;
}

/** A label pointing at a bundle version. The same shape as a prompt label. */
export type ContextLabel = PromptLabel;

/** One recorded change to a bundle. The same shape as a prompt history entry. */
export type ContextHistoryEntry = PromptHistoryEntry;

/** What a context promotion gate is asked to judge. */
export interface ContextPromotionContext {
  /** The bundle. */
  name: string;
  /** The version being promoted. */
  bundle: ContextBundle;
  /** The label it is being promoted to. */
  to: string;
  /** The label it is being promoted from, when the promotion names one. */
  from?: string;
  /** The version `to` serves now, if any. */
  current?: ContextBundle;
  /** The hub, for gates that look things up. */
  hub: ContextHub;
}

/** Decides whether a bundle version may be promoted to a label. */
export type ContextPromotionGate = (context: ContextPromotionContext) => Promise<GateResult> | GateResult;

/** The outcome of a promotion. */
export interface ContextPromotionResult {
  /** The label after the promotion. */
  label: ContextLabel;
  /** Every gate's verdict. */
  results: GateResult[];
  /** False when the label already served the version, so nothing moved. */
  changed: boolean;
}

/** A bundle with the prompts it pins, as one document that moves between projects. */
export interface ContextBundleExport {
  /** Always `nexus-context-bundle`. */
  format: 'nexus-context-bundle';
  /** The export format's version. */
  formatVersion: 1;
  /** The bundle version. */
  bundle: ContextBundle;
  /** Every pinned prompt version, when the hub has a prompt registry. */
  prompts: PromptVersion[];
}

/** Options for a `ContextHub`. */
export interface ContextHubOptions {
  /**
   * Where bundle versions, labels, and history live: any prompt store — memory, files, Redis, or
   * Postgres — given to the hub alone. Defaults to a `MemoryPromptStore`.
   */
  store?: PromptStore;
  /** The prompt registry pinned prompts come from. Commits check each pin exists; exports carry them. */
  prompts?: PromptRegistry;
  /** Gates run before a promotion, by the label promoted to. */
  gates?: Record<string, readonly ContextPromotionGate[]>;
  /** Called after every recorded change. */
  onChange?: (entry: ContextHistoryEntry) => void | Promise<void>;
  /**
   * Signs every new version, over its content and its pinned prompts' content, so another hub can
   * check where it came from. Signing a bundle that pins prompts needs `prompts`.
   */
  signer?: ContextSigner;
  /**
   * The keys whose signatures this hub trusts, for `verify()`, and for `requireSignature`. A signature
   * by a key the keyring does not hold is kept, but never trusted.
   */
  keyring?: ContextKeyring;
  /**
   * Refuses any bundle without a valid signature by a key in `keyring`: on import, and whenever a
   * version is served through `resolve()` or `renderPrompt()`.
   */
  requireSignature?: boolean;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** What `ContextHub.verify()` found. */
export interface ContextVerification {
  /** Whether a key in the keyring signed exactly this content. */
  trusted: boolean;
  /** The digest the content has now. */
  digest: string;
  /** The signature that verified, when one did. */
  signature?: ContextSignature;
}

/** Base class for context hub errors, each with a stable `code`. */
export class ContextHubError extends Error {
  constructor(
    message: string,
    /** Stable code, such as `CONTEXT_NOT_FOUND`. */
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ContextHubError';
  }
}

/** Raised for a bundle, version, or label that does not exist. */
export class ContextNotFoundError extends ContextHubError {
  constructor(
    /** The bundle. */
    public readonly bundle: string,
    /** The version or label asked for. */
    public readonly ref: string,
  ) {
    super(`Context bundle "${bundle}" has no version or label "${ref}"`, 'CONTEXT_NOT_FOUND');
    this.name = 'ContextNotFoundError';
  }
}

/** Raised when a label moved while it was being changed. */
export class ContextConflictError extends ContextHubError {
  constructor(bundle: string, label: string) {
    super(
      `Label "${label}" of context bundle "${bundle}" was changed by another writer; reload and retry`,
      'CONTEXT_CONFLICT',
    );
    this.name = 'ContextConflictError';
  }
}

/** Raised when a gate refuses a promotion. `results` holds every gate's verdict. */
export class ContextPromotionError extends ContextHubError {
  constructor(
    bundle: string,
    to: string,
    /** Every gate's verdict. */
    public readonly results: GateResult[],
  ) {
    const refused = results.filter((result) => !result.ok);
    super(
      `Promoting context bundle "${bundle}" to "${to}" was refused: ${refused
        .map((result) => `${result.gate}${result.reason ? ` (${result.reason})` : ''}`)
        .join(', ')}`,
      'CONTEXT_PROMOTION_REFUSED',
    );
    this.name = 'ContextPromotionError';
  }
}

/** Raised when a bundle has no signature the hub trusts, or its signatures do not match its content. */
export class ContextSignatureError extends ContextHubError {
  constructor(
    /** The bundle. */
    public readonly bundle: string,
    /** The version. */
    public readonly version: string,
    reason: string,
  ) {
    super(`Context bundle "${bundle}" ${version}: ${reason}`, 'CONTEXT_SIGNATURE');
    this.name = 'ContextSignatureError';
  }
}

/** Raised when a bundle definition, a pin, or an import is invalid. */
export class ContextDefinitionError extends ContextHubError {
  constructor(message: string) {
    super(message, 'CONTEXT_DEFINITION_ERROR');
    this.name = 'ContextDefinitionError';
  }
}

const VERSION_ID = /^c[0-9a-f]{12}$/;

/**
 * The content version of a bundle: `c` and the first 12 hex digits of a SHA-256 over its name,
 * description, prompts, instructions, tools, skills, and configuration. Metadata is left out.
 */
export async function contextVersion(definition: ContextBundleDefinition): Promise<string> {
  const content = canonicalJson({
    name: definition.name,
    description: definition.description,
    prompts: definition.prompts,
    instructions: definition.instructions,
    tools: definition.tools,
    skills: definition.skills,
    config: definition.config,
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  let hex = '';
  for (const byte of new Uint8Array(digest).subarray(0, 6)) hex += byte.toString(16).padStart(2, '0');
  return `c${hex}`;
}

/**
 * Versioned context bundles: prompts, instructions, tool sets, and skills versioned together,
 * labelled, promoted through gates, diffed, rolled back, and exported to move between projects.
 *
 * It works as the prompt registry does — `commit()` stores content under its version, so committing
 * unchanged content is a no-op; labels point at versions; every change is recorded — and it keeps its
 * state in a prompt store, so every adapter the prompt family has serves bundles too.
 */
export class ContextHub {
  /** Where versions, labels, and history live. */
  readonly store: PromptStore;
  private readonly now: () => Date;

  /** Versions already verified as trusted, which never change. */
  private readonly trusted = new Map<string, Promise<ContextVerification>>();

  constructor(private readonly options: ContextHubOptions = {}) {
    if (options.requireSignature && !options.keyring) {
      throw new TypeError('requireSignature needs a keyring of the keys the hub trusts');
    }
    this.store = options.store ?? new MemoryPromptStore();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Commits a bundle and returns its version. Unchanged content returns the existing version and
   * records nothing; `label` points labels at the version either way. With a prompt registry, every
   * pinned prompt version must exist in it.
   */
  async commit(
    definition: ContextBundleDefinition,
    options: { message?: string; author?: string; label?: string | readonly string[] } = {},
  ): Promise<ContextBundle> {
    return this.commitSigned(definition, options, []);
  }

  private async commitSigned(
    definition: ContextBundleDefinition,
    options: { message?: string; author?: string; label?: string | readonly string[] },
    inherited: readonly ContextSignature[],
  ): Promise<ContextBundle> {
    validate(definition);
    if (this.options.prompts) {
      for (const [role, pin] of Object.entries(definition.prompts ?? {})) {
        const found = await this.options.prompts.store.getVersion(pin.name, pin.version);
        if (!found) {
          throw new ContextDefinitionError(
            `Bundle "${definition.name}" pins ${role} to ${pin.name}@${pin.version}, which the registry does not have`,
          );
        }
      }
    }
    const id = await contextVersion(definition);
    let stored = await this.read(definition.name, id);
    if (!stored) {
      const [newest] = await this.versions(definition.name, { limit: 1 });
      const now = this.now().getTime();
      const after = newest ? Date.parse(newest.createdAt) + 1 : Number.NEGATIVE_INFINITY;
      stored = {
        ...structuredClone(definition),
        version: id,
        createdAt: new Date(Math.max(now, after)).toISOString(),
        ...(options.message === undefined ? {} : { message: options.message }),
        ...(options.author === undefined ? {} : { author: options.author }),
        ...(newest ? { parent: newest.version } : {}),
      };
      const signatures = [...inherited];
      if (this.options.signer) {
        const digest = await contextDigest(await this.signedContent(definition));
        signatures.push(await signDigest(this.options.signer, digest, this.now()));
      }
      if (signatures.length > 0) stored.signatures = signatures;
      await this.store.saveVersion(toStored(stored));
      await this.record({ name: definition.name, action: 'commit', version: id, by: options.author });
    }
    const labels = typeof options.label === 'string' ? [options.label] : (options.label ?? []);
    for (const label of labels) await this.label(definition.name, label, id, { by: options.author });
    return stored;
  }

  /** A version by content version, label, or `latest`, the default. Throws `ContextNotFoundError` when there is none. */
  async get(name: string, ref = 'latest'): Promise<ContextBundle> {
    if (ref === 'latest') {
      const [newest] = await this.versions(name, { limit: 1 });
      if (newest) return newest;
      throw new ContextNotFoundError(name, ref);
    }
    if (VERSION_ID.test(ref)) {
      const found = await this.read(name, ref);
      if (found) return found;
    }
    const label = await this.store.getLabel(name, ref);
    const found = label ? await this.read(name, label.version) : undefined;
    if (!found) throw new ContextNotFoundError(name, ref);
    return found;
  }

  /**
   * Whether a key in the hub's keyring signed exactly this bundle's content, and its pinned prompts'
   * content as the prompt registry holds them. A version's answer never changes, so it is checked
   * once.
   */
  async verify(bundle: ContextBundle): Promise<ContextVerification> {
    const key = `${bundle.name}@${bundle.version}`;
    let pending = this.trusted.get(key);
    if (!pending) {
      pending = this.check(bundle, await this.signedContent(bundle));
      this.trusted.set(key, pending);
      pending.catch(() => this.trusted.delete(key));
    }
    return pending;
  }

  /** A version with the reference experiments and traces record for it. */
  async resolve(name: string, ref = 'latest'): Promise<{ bundle: ContextBundle; reference: ContextReference }> {
    const bundle = await this.get(name, ref);
    await this.assertTrusted(bundle);
    return {
      bundle,
      reference: {
        name,
        version: bundle.version,
        ...(ref !== 'latest' && ref !== bundle.version ? { label: ref } : {}),
      },
    };
  }

  /**
   * Renders the prompt a bundle pins for a role, through the prompt registry, recording the bundle in
   * the request's `metadata.context` beside the prompt's own reference.
   */
  async renderPrompt(
    bundle: ContextBundle,
    role: string,
    variables: Record<string, unknown> = {},
    options: RenderOptions = {},
  ): Promise<RenderedPrompt> {
    const registry = this.options.prompts;
    if (!registry)
      throw new ContextDefinitionError('Rendering a pinned prompt needs the hub to have a prompt registry');
    await this.assertTrusted(bundle);
    const pin = bundle.prompts?.[role];
    if (!pin) throw new ContextNotFoundError(bundle.name, `prompt role "${role}"`);
    const version = await registry.get(pin.name, pin.version);
    const rendered = registry.renderVersion(
      { version, reference: { name: pin.name, version: pin.version } },
      variables,
      options,
    );
    return { ...rendered, metadata: { ...rendered.metadata, context: { name: bundle.name, version: bundle.version } } };
  }

  /** Points a label at a version, without gates. Throws `ContextConflictError` if the label moved meanwhile. */
  async label(
    name: string,
    label: string,
    ref: string,
    options: { by?: string; note?: string } = {},
  ): Promise<ContextLabel> {
    const bundle = await this.get(name, ref);
    const current = await this.store.getLabel(name, label);
    if (current?.version === bundle.version) return current;
    const next = this.pointer(name, label, bundle.version, options.by);
    if (!(await this.store.setLabel(next, current?.version ?? null))) throw new ContextConflictError(name, label);
    await this.record({
      name,
      action: 'label',
      label,
      version: bundle.version,
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
   * allows it. Throws `ContextPromotionError` when a gate refuses, unless `force` is set, in which case
   * the refusals are still reported and recorded in the note.
   */
  async promote(
    name: string,
    options: { to: string; from?: string; version?: string; by?: string; note?: string; force?: boolean },
  ): Promise<ContextPromotionResult> {
    const source = options.version ?? options.from;
    if (!source) throw new RangeError('promote() needs a version or a label to promote from');
    const bundle = await this.get(name, source);
    const currentLabel = await this.store.getLabel(name, options.to);
    if (currentLabel?.version === bundle.version) return { label: currentLabel, results: [], changed: false };
    const current = currentLabel ? await this.read(name, currentLabel.version) : undefined;

    const results: GateResult[] = [];
    for (const gate of this.options.gates?.[options.to] ?? []) {
      results.push(await gate({ name, bundle, to: options.to, from: options.from, current, hub: this }));
    }
    const refused = results.filter((result) => !result.ok);
    if (refused.length > 0 && !options.force) throw new ContextPromotionError(name, options.to, results);

    const next = this.pointer(name, options.to, bundle.version, options.by);
    if (!(await this.store.setLabel(next, currentLabel?.version ?? null)))
      throw new ContextConflictError(name, options.to);
    const forced = refused.length > 0 ? `forced past ${refused.map((result) => result.gate).join(', ')}` : undefined;
    await this.record({
      name,
      action: 'promote',
      label: options.to,
      version: bundle.version,
      previous: currentLabel?.version,
      from: options.from,
      by: options.by,
      note: [options.note, forced].filter(Boolean).join('; ') || undefined,
    });
    return { label: next, results, changed: true };
  }

  /** Moves a label back to where it pointed before its last change. */
  async rollback(name: string, label: string, options: { by?: string; note?: string } = {}): Promise<ContextLabel> {
    const current = await this.store.getLabel(name, label);
    if (!current) throw new ContextNotFoundError(name, label);
    const [last] = (await this.store.listHistory(name, { label, limit: 20 })).filter(
      (entry) => entry.previous && entry.previous !== current.version,
    );
    if (!last?.previous) throw new ContextNotFoundError(name, `${label} (no earlier version to roll back to)`);
    const next = this.pointer(name, label, last.previous, options.by);
    if (!(await this.store.setLabel(next, current.version))) throw new ContextConflictError(name, label);
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

  /** A bundle's changes, newest first, optionally for one label. */
  async history(name: string, options: { label?: string; limit?: number } = {}): Promise<ContextHistoryEntry[]> {
    return [...(await this.store.listHistory(name, options))];
  }

  /** A bundle's versions, newest first. */
  async versions(name: string, options: { limit?: number } = {}): Promise<ContextBundle[]> {
    return (await this.store.listVersions(name, options)).map(fromStored);
  }

  /** A bundle's labels. */
  async labels(name: string): Promise<ContextLabel[]> {
    return [...(await this.store.listLabels(name))];
  }

  /** Every bundle's name, sorted. */
  async names(): Promise<string[]> {
    return [...(await this.store.listNames())];
  }

  /** What changed between two versions or labels of a bundle. */
  async diff(name: string, from: string, to: string): Promise<ContextDiff> {
    const [before, after] = await Promise.all([this.get(name, from), this.get(name, to)]);
    return diffContexts(before, after);
  }

  /**
   * A bundle version as one document, with every prompt version it pins when the hub has a prompt
   * registry, so importing it elsewhere needs nothing else.
   */
  async export(name: string, ref = 'latest'): Promise<ContextBundleExport> {
    const bundle = await this.get(name, ref);
    const prompts: PromptVersion[] = [];
    if (this.options.prompts) {
      for (const pin of Object.values(bundle.prompts ?? {}))
        prompts.push(await this.options.prompts.get(pin.name, pin.version));
    }
    return { format: 'nexus-context-bundle', formatVersion: 1, bundle, prompts };
  }

  /**
   * Commits an exported bundle, and the prompts it carries into the hub's registry. Each prompt must
   * still have the version it was exported with, and the bundle its version, so an export edited by
   * hand is refused rather than imported under a version that no longer describes it.
   */
  async import(
    exported: ContextBundleExport,
    options: { label?: string | readonly string[]; by?: string } = {},
  ): Promise<ContextBundle> {
    if (exported?.format !== 'nexus-context-bundle' || exported.formatVersion !== 1) {
      throw new ContextDefinitionError('Not a nexus-context-bundle export, or an unsupported format version');
    }
    if (exported.prompts.length > 0 && !this.options.prompts) {
      throw new ContextDefinitionError('The export carries prompts; give the hub a prompt registry to import them');
    }
    for (const prompt of exported.prompts) {
      const {
        version,
        variables: _variables,
        createdAt: _createdAt,
        parent: _parent,
        message,
        author,
        ...definition
      } = prompt;
      const committed = await this.options.prompts?.commit(definition, {
        ...(message === undefined ? {} : { message }),
        ...((options.by ?? author) === undefined ? {} : { author: options.by ?? author }),
      });
      if (committed && committed.version !== version) {
        throw new ContextDefinitionError(
          `Prompt ${prompt.name} was exported as ${version} but its content is ${committed.version}`,
        );
      }
    }
    const {
      version,
      createdAt: _createdAt,
      parent: _parent,
      message,
      author,
      signatures = [],
      ...definition
    } = exported.bundle;
    if ((await contextVersion(definition)) !== version) {
      throw new ContextDefinitionError(
        `Bundle ${definition.name} was exported as ${version} but its content has changed`,
      );
    }
    // The signatures that claim this exact content are kept; one claiming other content is dropped.
    const digest = await contextDigest(signedContentOf(definition, exportedPrompts(exported)));
    const claims = signatures.filter((signature) => signature?.digest === digest);
    if (this.options.requireSignature && this.options.keyring) {
      const signed = await verifiedBy(this.options.keyring, digest, claims);
      if (!signed) {
        throw new ContextSignatureError(
          definition.name,
          version,
          signatures.length > 0
            ? 'no signature verifies against its content with a trusted key'
            : 'it is not signed, and this hub requires a signature',
        );
      }
    }
    return this.commitSigned(
      definition,
      {
        message: message ?? 'imported',
        ...((options.by ?? author) === undefined ? {} : { author: options.by ?? author }),
        ...(options.label === undefined ? {} : { label: options.label }),
      },
      claims,
    );
  }

  /** Refuses a bundle without a trusted signature, when the hub requires one. */
  private async assertTrusted(bundle: ContextBundle): Promise<void> {
    if (!this.options.requireSignature) return;
    const verification = await this.verify(bundle);
    if (!verification.trusted) {
      throw new ContextSignatureError(
        bundle.name,
        bundle.version,
        bundle.signatures?.length
          ? 'no signature verifies against its content with a trusted key'
          : 'it is not signed, and this hub requires a signature',
      );
    }
  }

  private async check(bundle: ContextBundle, content: ContextSignedContent): Promise<ContextVerification> {
    const digest = await contextDigest(content);
    const signature = this.options.keyring
      ? await verifiedBy(this.options.keyring, digest, bundle.signatures)
      : undefined;
    return { trusted: signature !== undefined, digest, ...(signature ? { signature } : {}) };
  }

  /** What a signature over this bundle covers, with its pinned prompts read from the registry. */
  private async signedContent(definition: ContextBundleDefinition): Promise<ContextSignedContent> {
    const pins = Object.entries(definition.prompts ?? {});
    if (pins.length > 0 && !this.options.prompts) {
      throw new ContextDefinitionError(
        `Bundle "${definition.name}" pins prompts; signing or verifying it needs the hub to have a prompt registry`,
      );
    }
    const prompts: PromptVersion[] = [];
    for (const [, pin] of pins) prompts.push(await (this.options.prompts as PromptRegistry).get(pin.name, pin.version));
    return signedContentOf(definition, prompts);
  }

  private async read(name: string, version: string): Promise<ContextBundle | undefined> {
    const stored = await this.store.getVersion(name, version);
    return stored ? fromStored(stored) : undefined;
  }

  private pointer(name: string, label: string, version: string, by?: string): ContextLabel {
    return { name, label, version, updatedAt: this.now().toISOString(), ...(by ? { by } : {}) };
  }

  private async record(entry: Omit<ContextHistoryEntry, 'at'>): Promise<void> {
    const recorded = Object.fromEntries(
      Object.entries({ ...entry, at: this.now().toISOString() }).filter(([, value]) => value !== undefined),
    ) as unknown as ContextHistoryEntry;
    await this.store.appendHistory(recorded);
    await this.options.onChange?.(recorded);
  }
}

function validate(definition: ContextBundleDefinition): void {
  if (!definition?.name || typeof definition.name !== 'string')
    throw new ContextDefinitionError('A bundle needs a name');
  for (const [role, pin] of Object.entries(definition.prompts ?? {})) {
    if (!pin?.name || !/^p[0-9a-f]{12}$/.test(pin.version ?? '')) {
      throw new ContextDefinitionError(
        `Bundle "${definition.name}" pins ${role} without a prompt name and content version`,
      );
    }
  }
  const names = new Set<string>();
  for (const tool of definition.tools ?? []) {
    if (!tool?.name) throw new ContextDefinitionError(`Bundle "${definition.name}" has a tool without a name`);
    if (names.has(tool.name))
      throw new ContextDefinitionError(`Bundle "${definition.name}" offers "${tool.name}" twice`);
    names.add(tool.name);
  }
  for (const [skill, value] of Object.entries(definition.skills ?? {})) {
    if (typeof value?.description !== 'string' || typeof value.instructions !== 'string') {
      throw new ContextDefinitionError(
        `Skill "${skill}" of bundle "${definition.name}" needs a description and instructions`,
      );
    }
  }
}

// A prompt store holds prompt versions; a bundle is kept in one as a version with no messages, which
// every prompt adapter stores as the JSON document it is.
/** The content a signature covers: the bundle's versioned fields, and each pinned prompt's. */
function signedContentOf(definition: ContextBundleDefinition, prompts: readonly PromptVersion[]): ContextSignedContent {
  const byPin = new Map(prompts.map((prompt) => [`${prompt.name}@${prompt.version}`, prompt]));
  const pinned: ContextSignedContent['prompts'] = {};
  for (const [role, pin] of Object.entries(definition.prompts ?? {})) {
    const prompt = byPin.get(`${pin.name}@${pin.version}`);
    if (!prompt)
      throw new ContextDefinitionError(
        `Bundle "${definition.name}" pins ${role} to ${pin.name}@${pin.version}, which is not at hand`,
      );
    pinned[role] = {
      name: prompt.name,
      messages: prompt.messages,
      partials: prompt.partials,
      config: prompt.config,
      defaults: prompt.defaults,
    };
  }
  return {
    bundle: {
      name: definition.name,
      description: definition.description,
      prompts: definition.prompts,
      instructions: definition.instructions,
      tools: definition.tools,
      skills: definition.skills,
      config: definition.config,
    },
    prompts: pinned,
  };
}

/** The prompts an export carries, as prompt versions. */
function exportedPrompts(exported: ContextBundleExport): PromptVersion[] {
  return exported.prompts;
}

function toStored(bundle: ContextBundle): PromptVersion {
  return { ...bundle, messages: [], variables: [] } as unknown as PromptVersion;
}

function fromStored(stored: PromptVersion): ContextBundle {
  const { messages: _messages, variables: _variables, ...bundle } = stored as PromptVersion & Record<string, unknown>;
  return bundle as unknown as ContextBundle;
}
