/**
 * Which release's defaults apply where an option is left out: 2.x's, or a preview of 3.0's. 3.0 turns on
 * three settings that 2.x keeps opt-in, because turning them on changes what an upgrade does; the
 * preview turns on all three at once, so an application can run as 3.0 will before it upgrades. An
 * option set explicitly always wins, under either.
 */

/** A release whose defaults apply: `2.x`, the default, or `3.0`, a preview of the next major release's. */
export type NexusDefaults = '2.x' | '3.0';

/** One default that 3.0 changes: what it is, what 2.x does, what 3.0 does, and what to do first. */
export interface DefaultChange {
  /** The setting, as its option is named. */
  setting: string;
  /** Where it is set. */
  module: string;
  /** What 2.x does when the option is left out. */
  today: string;
  /** What 3.0, and the preview, does when it is left out. */
  next: string;
  /** What to do before turning it on, if anything. */
  before: string;
}

/** The defaults 3.0 changes, each turned on by the preview. */
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
    before: 'Run 2.2 or later on every worker sharing the prefix, and call reindex() once.',
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
 * Chooses which release's defaults apply to everything created after it: `3.0` previews the next
 * major release's, `2.x` returns to today's. Call it before creating a tracer, an operation store, or
 * a deployment: each reads the defaults when it is created. Overrides `NEXUS_DEFAULTS`.
 */
export function useDefaults(release: NexusDefaults): void {
  chosen = checked(release, 'useDefaults()');
}

/**
 * The defaults in effect: as `useDefaults()` chose, else the `NEXUS_DEFAULTS` environment variable,
 * `2.x` or `3.0`, else `2.x`. Throws for any other value of the variable, rather than ignore a typo.
 */
export function nexusDefaults(): NexusDefaults {
  if (chosen) return chosen;
  const variable = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.NEXUS_DEFAULTS;
  return variable === undefined || variable === '' ? '2.x' : checked(variable, 'NEXUS_DEFAULTS');
}

function checked(release: string, where: string): NexusDefaults {
  if (release === '2.x' || release === '3.0') return release;
  throw new Error(`${where} takes 2.x or 3.0, not ${JSON.stringify(release)}`);
}
