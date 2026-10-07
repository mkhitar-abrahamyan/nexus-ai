/**
 * The adapter kit: how a package outside this repository builds an adapter — a provider, an
 * embeddings backend, a vector store, a retriever, or a long-term store — and proves it works.
 *
 * Each `define*()` takes what the adapter is, the releases of `nexus-ai-pro` it supports, what it
 * can do, and how to create it, and returns an adapter whose instances normalize every failure into
 * an `AdapterError` and report every call for telemetry. Its `verify()` runs the same contract suite
 * this package runs on its own adapters, skipping only what the adapter declares it cannot do, with a
 * small benchmark held to the budgets it declares.
 */
import type { EmbeddingProvider, VectorStore } from '../hallucination/retrieval.js';
import type { BaseProvider } from '../providers/base.js';
import type { Retriever } from '../rag/retrievers.js';
import {
  type EmbeddingProviderConformanceOptions,
  runEmbeddingProviderConformance,
} from '../testing/embedding-provider-conformance.js';
import { type ProviderConformanceOptions, runProviderConformance } from '../testing/provider-conformance.js';
import type { EmbeddingsProvider } from '../types/embeddings.js';
import type { Store } from '../types/store.js';
import { NEXUS_VERSION } from '../version.js';
import {
  type AdapterCheck,
  type RetrieverCapabilities,
  type RetrieverContractOptions,
  runRetrieverContract,
  runStoreContract,
  runVectorStoreContract,
  type StoreCapabilities,
  type VectorStoreCapabilities,
} from './contracts.js';
import { AdapterError, type AdapterErrorClass, classifyAdapterError } from './errors.js';
import { satisfiesRange } from './semver.js';

export {
  ADAPTER_FIXTURE_PASSAGES,
  type AdapterCheck,
  type RetrieverCapabilities,
  type RetrieverContractOptions,
  runRetrieverContract,
  runStoreContract,
  runVectorStoreContract,
  type StoreCapabilities,
  type VectorStoreCapabilities,
  type VectorStoreContractOptions,
} from './contracts.js';
export { AdapterError, type AdapterErrorClass, type AdapterErrorCode, classifyAdapterError } from './errors.js';
export { parseVersion, satisfiesRange } from './semver.js';

/** The kinds of adapter the kit builds. */
export type AdapterKind = 'provider' | 'embeddings' | 'vector-store' | 'retriever' | 'store';

/** What every adapter declares about itself. */
export interface AdapterDefinition<Config, Instance, Capabilities> {
  /** Its name, usually its package name, such as `@acme/nexus-milvus`. */
  name: string;
  /** Its own version. */
  version: string;
  /** The releases of `nexus-ai-pro` it works with, as a range: `>=2.4.0 <3`. */
  nexus: string;
  /** What it can do. The contract skips what it declares it cannot, and fails what it claims and cannot. */
  capabilities: Capabilities;
  /** Creates an instance from its configuration. */
  create(config: Config): Instance | Promise<Instance>;
  /**
   * Classifies a failure from the service behind the adapter, when the kit's own reading of statuses
   * and network codes is not enough. Returning nothing falls back to that reading.
   */
  normalizeError?(error: unknown, operation: string): AdapterErrorClass | undefined;
  /** The p95 latency each operation must stay within in `verify()`'s benchmark, in milliseconds. */
  budgets?: Readonly<Record<string, number>>;
}

/** One call through an adapter, for telemetry. */
export interface AdapterCallEvent {
  /** The adapter. */
  adapter: string;
  /** Its kind. */
  kind: AdapterKind;
  /** The method called, such as `search`. */
  operation: string;
  /** How long the call took, in milliseconds. */
  durationMs: number;
  /** Whether it succeeded. */
  ok: boolean;
  /** How it failed, when it did. */
  error?: AdapterErrorClass;
}

/** Options for an adapter's `create()`. */
export interface AdapterCreateOptions {
  /** Receives every call: the hook a tracer, a metrics exporter, or a log subscribes with. */
  onCall?: (event: AdapterCallEvent) => void;
}

/** What `verify()` measured for one operation over the contract's calls. */
export interface AdapterBenchmarkEntry {
  /** Successful calls measured. */
  calls: number;
  /** Median latency, in milliseconds. */
  p50Ms: number;
  /** 95th-percentile latency, in milliseconds. */
  p95Ms: number;
}

/** What `verify()` found. */
export interface AdapterReport {
  /** The adapter. */
  adapter: string;
  /** Its version. */
  version: string;
  /** Its kind. */
  kind: AdapterKind;
  /** The `nexus-ai-pro` release it was verified against. */
  nexusVersion: string;
  /** Whether that release is inside the adapter's declared range. */
  compatible: boolean;
  /** True when it is compatible and every check that ran held. */
  passed: boolean;
  /** Every check, in order, with skipped ones marked. */
  checks: AdapterCheck[];
  /** Latency per operation over the contract's calls. */
  benchmark: Record<string, AdapterBenchmarkEntry>;
}

/** An adapter built with the kit. */
export interface Adapter<Config, Instance, Capabilities, VerifyOptions>
  extends Readonly<Omit<AdapterDefinition<Config, Instance, Capabilities>, 'create'>> {
  /** Its kind. */
  readonly kind: AdapterKind;
  /** Creates an instance whose every call normalizes its failures and reports itself. */
  create(config: Config, options?: AdapterCreateOptions): Promise<Instance>;
  /** Whether a release of `nexus-ai-pro` is inside the declared range. Defaults to the installed one. */
  compatible(nexusVersion?: string): boolean;
  /** Runs the contract suite for its kind against a fresh instance, with a benchmark. */
  verify(config: Config, options: VerifyOptions): Promise<AdapterReport>;
}

/** The methods each kind's instances are instrumented on. */
const OPERATIONS: Record<AdapterKind, readonly string[]> = {
  provider: ['complete', 'healthCheck'],
  embeddings: ['embed'],
  'vector-store': ['add', 'search', 'searchVector', 'delete'],
  retriever: ['retrieve', 'add', 'delete'],
  store: ['put', 'get', 'delete', 'search', 'listNamespaces'],
};

function build<Config, Instance extends object, Capabilities, VerifyOptions>(
  kind: AdapterKind,
  definition: AdapterDefinition<Config, Instance, Capabilities>,
  contract: (instance: Instance, options: VerifyOptions, capabilities: Capabilities) => Promise<AdapterCheck[]>,
): Adapter<Config, Instance, Capabilities, VerifyOptions> {
  for (const field of ['name', 'version', 'nexus'] as const) {
    if (typeof definition[field] !== 'string' || !definition[field]) throw new TypeError(`An adapter needs a ${field}`);
  }
  satisfiesRange(NEXUS_VERSION, definition.nexus); // refuses a range that cannot be read, at definition time

  const create = async (config: Config, options: AdapterCreateOptions = {}): Promise<Instance> =>
    instrument(kind, definition, await definition.create(config), options);

  return {
    kind,
    name: definition.name,
    version: definition.version,
    nexus: definition.nexus,
    capabilities: definition.capabilities,
    ...(definition.normalizeError ? { normalizeError: definition.normalizeError } : {}),
    ...(definition.budgets ? { budgets: definition.budgets } : {}),
    create,
    compatible: (nexusVersion = NEXUS_VERSION) => satisfiesRange(nexusVersion, definition.nexus),
    async verify(config, options) {
      const durations = new Map<string, number[]>();
      const instance = await create(config, {
        onCall: (event) => {
          if (event.ok) durations.set(event.operation, [...(durations.get(event.operation) ?? []), event.durationMs]);
        },
      });
      const compatible = satisfiesRange(NEXUS_VERSION, definition.nexus);
      const checks: AdapterCheck[] = [
        {
          name: `declares support for nexus-ai-pro ${NEXUS_VERSION}`,
          ok: compatible,
          ...(compatible ? {} : { detail: `the declared range is ${definition.nexus}` }),
        },
        ...(await contract(instance, options, definition.capabilities)),
      ];
      const benchmark: Record<string, AdapterBenchmarkEntry> = {};
      for (const [operation, values] of durations) {
        const sorted = [...values].sort((a, b) => a - b);
        const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0);
        benchmark[operation] = { calls: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95) };
      }
      for (const [operation, budget] of Object.entries(definition.budgets ?? {})) {
        const measured = benchmark[operation]?.p95Ms;
        checks.push(
          measured === undefined
            ? {
                name: `${operation} stays within ${budget} ms at p95`,
                ok: true,
                skipped: true,
                detail: 'not called by the contract',
              }
            : {
                name: `${operation} stays within ${budget} ms at p95`,
                ok: measured <= budget,
                ...(measured <= budget ? {} : { detail: `measured ${measured} ms` }),
              },
        );
      }
      return {
        adapter: definition.name,
        version: definition.version,
        kind,
        nexusVersion: NEXUS_VERSION,
        compatible,
        passed: checks.every((check) => check.ok),
        checks,
        benchmark,
      };
    },
  };
}

/**
 * Wraps an instance so each listed method is timed, reported, and has its failures normalized. The
 * method runs on the instance itself, so a class with private fields works unchanged.
 */
function instrument<Instance extends object>(
  kind: AdapterKind,
  definition: AdapterDefinition<unknown, Instance, unknown>,
  instance: Instance,
  options: AdapterCreateOptions,
): Instance {
  const operations = new Set(OPERATIONS[kind]);
  return new Proxy(instance, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !operations.has(property) || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const started = performance.now();
        try {
          const result = await (value as (...input: unknown[]) => unknown).apply(target, args);
          options.onCall?.({
            adapter: definition.name,
            kind,
            operation: property,
            durationMs: performance.now() - started,
            ok: true,
          });
          return result;
        } catch (error) {
          const failure =
            error instanceof AdapterError
              ? {
                  code: error.code,
                  retryable: error.retryable,
                  ...(error.status === undefined ? {} : { status: error.status }),
                }
              : (definition.normalizeError?.(error, property) ?? classifyAdapterError(error));
          options.onCall?.({
            adapter: definition.name,
            kind,
            operation: property,
            durationMs: performance.now() - started,
            ok: false,
            error: failure,
          });
          throw error instanceof AdapterError ? error : new AdapterError(definition.name, property, failure, error);
        }
      };
    },
  });
}

/** What a chat provider supports, which decides the conformance cases it runs. */
export interface ProviderAdapterCapabilities {
  /** `stream()`. */
  streaming: boolean;
  /** JSON output through `responseFormat`. */
  json: boolean;
  /** Tool calls. */
  tools: boolean;
  /** `healthCheck()`. */
  health: boolean;
}

/** Options for a provider adapter's `verify()`: the model and, if you like, cases of your own. */
export type ProviderVerifyOptions = Pick<ProviderConformanceOptions, 'model' | 'fixtures'>;

/** Builds a chat-provider adapter, verified by the provider conformance suite. */
export function defineProviderAdapter<Config, Instance extends BaseProvider>(
  definition: AdapterDefinition<Config, Instance, ProviderAdapterCapabilities>,
): Adapter<Config, Instance, ProviderAdapterCapabilities, ProviderVerifyOptions> {
  return build('provider', definition, async (provider, options, capabilities) => {
    const results = await runProviderConformance(definition.name, provider, {
      ...options,
      testStream: capabilities.streaming,
      testJson: capabilities.json,
      testTools: capabilities.tools,
      testHealth: capabilities.health,
    });
    return results.flatMap((result) => [
      {
        name: `completes the ${result.caseName} case`,
        ok: result.completeOk,
        ...(result.completeOk ? {} : { detail: result.error ?? 'the response was not accepted' }),
      },
      ...(result.streamOk === undefined ? [] : [{ name: `streams the ${result.caseName} case`, ok: result.streamOk }]),
      ...(result.healthOk === undefined ? [] : [{ name: 'answers its health check', ok: result.healthOk }]),
    ]);
  });
}

/** What an embeddings backend supports. */
export interface EmbeddingsAdapterCapabilities {
  /** Stops an embedding call when its signal aborts. */
  abort: boolean;
  /** Returns the same vectors for the same input. */
  deterministic: boolean;
}

/** Options for an embeddings adapter's `verify()`. */
export type EmbeddingsVerifyOptions = Pick<EmbeddingProviderConformanceOptions, 'model' | 'fixtures'>;

/** Builds an embeddings adapter, verified by the embeddings conformance suite. */
export function defineEmbeddingsAdapter<Config, Instance extends EmbeddingsProvider>(
  definition: AdapterDefinition<Config, Instance, EmbeddingsAdapterCapabilities>,
): Adapter<Config, Instance, EmbeddingsAdapterCapabilities, EmbeddingsVerifyOptions> {
  return build('embeddings', definition, async (provider, options, capabilities) => {
    const results = await runEmbeddingProviderConformance(definition.name, provider, {
      ...options,
      testAbort: capabilities.abort,
      testDeterminism: capabilities.deterministic,
    });
    return results.flatMap((result) => [
      {
        name: `embeds the ${result.caseName} case`,
        ok: result.ok,
        ...(result.ok ? {} : { detail: result.error ?? 'not accepted' }),
      },
      ...(result.abortOk === undefined
        ? []
        : [{ name: `stops the ${result.caseName} case when aborted`, ok: result.abortOk }]),
    ]);
  });
}

/** Options for a vector-store adapter's `verify()`. */
export interface VectorStoreVerifyOptions {
  /** The embedding function the store embeds with, to compute a query vector. */
  embed: EmbeddingProvider;
  /** Waits for writes to become searchable, for an eventually consistent index. */
  settle?: () => Promise<void>;
}

/** Builds a vector-store adapter, verified by the `VectorStore` contract. */
export function defineVectorStoreAdapter<Config, Instance extends VectorStore>(
  definition: AdapterDefinition<Config, Instance, VectorStoreCapabilities>,
): Adapter<Config, Instance, VectorStoreCapabilities, VectorStoreVerifyOptions> {
  return build('vector-store', definition, (store, options, capabilities) =>
    runVectorStoreContract(store, { ...options, capabilities }),
  );
}

/** Options for a retriever adapter's `verify()`. */
export type RetrieverVerifyOptions = Omit<RetrieverContractOptions, 'capabilities'>;

/** Builds a retriever adapter, verified by the `Retriever` contract, and the `SparseRetriever` one when it takes writes. */
export function defineRetrieverAdapter<Config, Instance extends Retriever>(
  definition: AdapterDefinition<Config, Instance, RetrieverCapabilities>,
): Adapter<Config, Instance, RetrieverCapabilities, RetrieverVerifyOptions> {
  return build('retriever', definition, (retriever, options, capabilities) =>
    runRetrieverContract(retriever, { ...options, capabilities }),
  );
}

/** Builds a long-term store adapter, verified by the `Store` contract. */
export function defineStoreAdapter<Config, Instance extends Store>(
  definition: AdapterDefinition<Config, Instance, StoreCapabilities>,
): Adapter<Config, Instance, StoreCapabilities, Record<string, never>> {
  return build('store', definition, (store, _options, capabilities) => runStoreContract(store, { capabilities }));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
