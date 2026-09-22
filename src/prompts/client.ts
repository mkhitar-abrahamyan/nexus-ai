import type {
  PromptDefinition,
  PromptLabel,
  PromptReference,
  PromptStore,
  PromptVariant,
  PromptVersion,
  RenderedPrompt,
  RenderOptions,
} from '../types/prompts.js';
import { PromptNotFoundError } from './errors.js';
import { chooseVariant } from './variant.js';
import { type CompiledPrompt, compilePrompt, renderCompiled } from './template.js';
import { promptVersion } from './version.js';

/** The read side of a prompt store, which is all serving needs. */
export type PromptSource = Pick<PromptStore, 'getLabel' | 'getVersion'>;

/** Options for a prompt client. */
export interface PromptClientOptions {
  /** Where labels and versions are read from: a store, or a registry's `store`. */
  source: PromptSource;
  /** Label served when a call names none. Defaults to `production`. */
  label?: string;
  /** How long a label is served without asking the source again, in milliseconds. Defaults to 60 seconds. */
  ttlMs?: number;
  /**
   * How long after `ttlMs` a label is still served immediately while it refreshes in the background,
   * in milliseconds. Defaults to `ttlMs`. Past it, a call waits for the refresh.
   */
  staleWhileRevalidateMs?: number;
  /**
   * Serves the last version seen when a refresh fails, however old, so a registry outage does not take
   * prompts down with it. Defaults to true.
   */
  serveStaleOnError?: boolean;
  /** Definitions served when the source has nothing and nothing is cached, such as the prompts bundled in code. */
  fallbacks?: ReadonlyArray<PromptDefinition | { definition: PromptDefinition }>;
  /** Receives refresh failures, including the ones hidden by serving a stale version. */
  onError?: (error: unknown, name: string, label: string) => void;
  /** Labels cached before the least recently refreshed is dropped. Defaults to 500. */
  maxEntries?: number;
  /** Replaces the system clock, in epoch milliseconds, for tests. */
  now?: () => number;
}

/** A version chosen for one call, and how it was obtained. */
export interface ServedPrompt {
  /** The version served. */
  version: PromptVersion;
  /** Name, version, label, and arm, as rendered requests record them. */
  reference: PromptReference;
  /** `cache` when fresh, `stale` when served past its TTL, `source` when just fetched, `fallback` when bundled. */
  from: 'cache' | 'stale' | 'source' | 'fallback';
}

interface LabelEntry {
  label: PromptLabel;
  fetchedAt: number;
}

/**
 * Serves prompts by label to application code, fast and through outages.
 *
 * A label is read from the source at most once per `ttlMs`; within the stale window a call is answered
 * from cache while the label refreshes in the background, and when the source is unreachable the last
 * version seen keeps serving. Versions never change, so once fetched they are kept. A split label
 * picks its arm by `key`, so the same user sees the same version on every call.
 */
export class PromptClient {
  private readonly labels = new Map<string, LabelEntry>();
  private readonly inflight = new Map<string, Promise<LabelEntry>>();
  private readonly versions = new Map<string, { version: PromptVersion; compiled: CompiledPrompt }>();
  private readonly fallbacks = new Map<string, PromptDefinition>();
  private readonly fallbackVersions = new Map<string, Promise<PromptVersion>>();
  private readonly now: () => number;

  constructor(private readonly options: PromptClientOptions) {
    this.now = options.now ?? Date.now;
    for (const item of options.fallbacks ?? []) {
      const definition = 'definition' in item ? item.definition : item;
      this.fallbacks.set(definition.name, definition);
    }
  }

  /** The version to serve for a prompt, choosing an A/B arm by `key` when the label splits traffic. */
  async get(name: string, options: { label?: string; key?: string } = {}): Promise<ServedPrompt> {
    const label = options.label ?? this.options.label ?? 'production';
    const cacheKey = `${name}\u0000${label}`;
    const ttl = this.options.ttlMs ?? 60_000;
    const window = this.options.staleWhileRevalidateMs ?? ttl;
    const entry = this.labels.get(cacheKey);
    let from: ServedPrompt['from'] = 'cache';
    let current = entry;

    const age = entry ? this.now() - entry.fetchedAt : Number.POSITIVE_INFINITY;
    if (entry && age >= ttl && age < ttl + window) {
      from = 'stale';
      void this.refreshEntry(name, label).catch((error: unknown) => this.options.onError?.(error, name, label));
    } else if (!entry || age >= ttl) {
      try {
        current = await this.refreshEntry(name, label);
        from = 'source';
      } catch (error) {
        if (entry && this.options.serveStaleOnError !== false) {
          this.options.onError?.(error, name, label);
          from = 'stale';
        } else {
          const fallback = await this.fallback(name, label, error);
          if (fallback) return fallback;
          throw error;
        }
      }
    }

    const pointer = (current as LabelEntry).label;
    const variant = pointer.variants?.length
      ? chooseVariant(
          pointer.variants,
          options.key === undefined ? undefined : `${options.key}\u0000${name}\u0000${label}`,
        )
      : undefined;
    const id =
      variant === undefined || !pointer.variants
        ? pointer.version
        : (pointer.variants[variant] as PromptVariant).version;
    const cached = this.versions.get(`${name}\u0000${id}`) ?? (await this.loadVersion(name, id));
    return {
      version: cached.version,
      reference: { name, version: id, label, ...(variant === undefined ? {} : { variant }) },
      from,
    };
  }

  /** Renders a prompt by label, recording what was served in `metadata.prompt`. */
  async render(
    name: string,
    variables: Record<string, unknown> = {},
    options: RenderOptions & { label?: string; key?: string } = {},
  ): Promise<RenderedPrompt> {
    const served = await this.get(name, options);
    const compiled =
      this.versions.get(`${name}\u0000${served.version.version}`)?.compiled ?? compilePrompt(served.version);
    return renderCompiled(compiled, served.version, variables, served.reference, options);
  }

  /**
   * Reads a label from the source now, with every version it serves, and caches them. Concurrent
   * refreshes of one label share a request.
   */
  async refresh(name: string, label = this.options.label ?? 'production'): Promise<PromptLabel> {
    return (await this.refreshEntry(name, label)).label;
  }

  private refreshEntry(name: string, label: string): Promise<LabelEntry> {
    const cacheKey = `${name}\u0000${label}`;
    const pending = this.inflight.get(cacheKey);
    if (pending) return pending;

    const refreshing = (async () => {
      const pointer = await this.options.source.getLabel(name, label);
      if (!pointer) throw new PromptNotFoundError(name, label);
      const ids = new Set([pointer.version, ...(pointer.variants ?? []).map((variant) => variant.version)]);
      for (const id of ids) if (!this.versions.has(`${name}\u0000${id}`)) await this.loadVersion(name, id);
      const next: LabelEntry = { label: pointer, fetchedAt: this.now() };
      this.labels.delete(cacheKey);
      this.labels.set(cacheKey, next);
      const max = this.options.maxEntries ?? 500;
      while (this.labels.size > max) this.labels.delete(this.labels.keys().next().value as string);
      return next;
    })().finally(() => this.inflight.delete(cacheKey));

    this.inflight.set(cacheKey, refreshing);
    return refreshing;
  }

  /** Forgets every cached label and version. */
  clear(): void {
    this.labels.clear();
    this.versions.clear();
  }

  private async loadVersion(name: string, id: string): Promise<{ version: PromptVersion; compiled: CompiledPrompt }> {
    const version = await this.options.source.getVersion(name, id);
    if (!version) throw new PromptNotFoundError(name, id);
    const loaded = { version, compiled: compilePrompt(version) };
    this.versions.set(`${name}\u0000${id}`, loaded);
    return loaded;
  }

  private async fallback(name: string, label: string, error: unknown): Promise<ServedPrompt | undefined> {
    const definition = this.fallbacks.get(name);
    if (!definition) return undefined;
    this.options.onError?.(error, name, label);
    let pending = this.fallbackVersions.get(name);
    if (!pending) {
      pending = promptVersion(definition).then((id) => {
        const compiled = compilePrompt(definition);
        const version: PromptVersion = {
          ...definition,
          version: id,
          variables: compiled.variables,
          createdAt: new Date(0).toISOString(),
        };
        this.versions.set(`${name}\u0000${id}`, { version, compiled });
        return version;
      });
      this.fallbackVersions.set(name, pending);
    }
    const version = await pending;
    return { version, reference: { name, version: version.version, label }, from: 'fallback' };
  }
}
