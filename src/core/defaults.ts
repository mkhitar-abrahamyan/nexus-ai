/**
 * Which release's defaults apply where an option is left out: 3.0's, or 2.x's. 3.0 turns on three
 * settings that 2.x kept opt-in; `2.x` keeps all three off at once, so an application can upgrade first
 * and turn them on when it is ready. An option set explicitly always wins, under either.
 */

/** A release whose defaults apply: `3.0`, the default, or `2.x`, which keeps 2.x's three settings off. */
export type NexusDefaults = '2.x' | '3.0';

/** One default that 3.0 changes: what it is, what 2.x does, what 3.0 does, and what to do first. */
export interface DefaultChange {
  /** The setting, as its option is named. */
  setting: string;
  /** Where it is set. */
  module: string;
  /** What 2.x did when the option is left out, as `useDefaults('2.x')` still does. */
  today: string;
  /** What 3.0 does when it is left out. */
  next: string;
  /** What to do before turning it on, if anything. */
  before: string;
}

/** The defaults 3.0 changes, each kept as 2.x had it by `useDefaults('2.x')`. */
export const DEFAULT_CHANGES: readonly DefaultChange[] = [
  {
    setting: 'Tracer incremental',
    module: 'nexus-ai-pro/tracing',
    today: 'false: a trace is written when its root run finishes',
    next: 'true on a durable trace store: each run is written as it starts and again as it ends, so a run in a process that dies is not lost',
    before: 'Nothing; close what a process that died left open with closeAbandonedRuns().',
  },
  {
    setting: 'RedisOperationStore index',
    module: 'nexus-ai-pro/operations',
    today: 'false: finding queued work reads every record',
    next: 'true where the client has zadd, zrem, and zrangebyscore: queued and leased work is kept in sorted sets',
    before:
      'Call reindex() once no worker without the index shares the prefix: work such a worker queued is in the index only after it.',
  },
  {
    setting: 'Deployments bucketStrategy',
    module: 'nexus-ai-pro/server',
    today: 'fnv1a-v1 for a deployment first recorded',
    next: 'hash-v2 for a deployment first recorded, which spreads sequential thread ids evenly; a recorded deployment keeps its own',
    before: 'Nothing; a deployment already recorded keeps the strategy it records, and bucketing() changes one.',
  },
];

let chosen: NexusDefaults | undefined;

/**
 * Chooses which release's defaults apply to everything created after it: `3.0`, the default, or `2.x`,
 * which keeps the three settings 3.0 turns on off, for an application that upgrades before it turns them
 * on. Call it before creating a tracer, an operation store, or a deployment: each reads the defaults when
 * it is created. Overrides `NEXUS_DEFAULTS`.
 */
export function useDefaults(release: NexusDefaults): void {
  chosen = checked(release, 'useDefaults()');
}

/**
 * The defaults in effect: as `useDefaults()` chose, else the `NEXUS_DEFAULTS` environment variable,
 * `2.x` or `3.0`, else `3.0`. Throws for any other value of the variable, rather than ignore a typo.
 */
export function nexusDefaults(): NexusDefaults {
  if (chosen) return chosen;
  const variable = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.NEXUS_DEFAULTS;
  return variable === undefined || variable === '' ? '3.0' : checked(variable, 'NEXUS_DEFAULTS');
}

function checked(release: string, where: string): NexusDefaults {
  if (release === '2.x' || release === '3.0') return release;
  throw new Error(`${where} takes 2.x or 3.0, not ${JSON.stringify(release)}`);
}
