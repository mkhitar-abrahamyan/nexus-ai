/**
 * Checks a deployment before it serves traffic: the runtime, credentials, the database and its
 * migrations, Redis, the operation queue, the model registry, provider health, and settings that
 * only work in one process. `nexus doctor` runs the same checks from a shell.
 *
 * Every check is cheap and read-only, and anything heavy — the model registry, the migration lists —
 * is loaded only when its check runs, so an application can call `diagnose()` at boot or from a
 * health endpoint.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { MigrationStatus, SchemaMigration } from '../utils/schema-migrations.js';

/** How one check came out: `fail` breaks the deployment, `warn` needs a look, `skip` had nothing to check. */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

/** One check's result. */
export interface DoctorCheck {
  /** A stable id, such as `node` or `migrations`. */
  id: string;
  /** What was checked, in a few words. */
  title: string;
  /** How it came out. */
  status: DoctorStatus;
  /** What was found. Never a secret's value. */
  detail: string;
  /** What to do about a warning or a failure. */
  hint?: string;
}

/** Every check's result, and whether the deployment can run. */
export interface DoctorReport {
  /** The checks, in the order they ran. */
  checks: DoctorCheck[];
  /** True when nothing failed. */
  ok: boolean;
  /** Checks that failed. */
  failures: number;
  /** Checks that warned. */
  warnings: number;
}

/** A database for the doctor to reach, as `nexus db` reaches one. */
export interface DoctorDatabase {
  /** A Postgres client (`query`) or a SQLite handle or client. */
  client: unknown;
  /** Which kind it is. Detected from the client when omitted. */
  dialect?: 'postgres' | 'sqlite';
  /** The migrations it should have. Defaults to every bundled adapter's on its default tables. */
  migrations?: readonly SchemaMigration[];
  /** The table that records applied migrations. */
  table?: string;
}

/** What the doctor knows about how the application is deployed. */
export interface DoctorDeployment {
  /** How many replicas run it. Settings that keep state in one process are checked only above 1. */
  replicas: number;
  /**
   * The stores and shared state it uses, by any name: a checkpointer, the operation store, the
   * server's state, tenant usage, a rate-limit store, a circuit store, a cache, a tracer. Each is
   * reported when it keeps its state in process memory, where each replica would see only its own,
   * and when it lacks an opt-in setting a deployment needs: a Redis operation store without its
   * dispatch index, or a tracer writing to a persistent store without incremental tracing.
   */
  stores?: Record<string, unknown>;
}

/** What `diagnose()` checks. Everything is optional; a check without its input is skipped. */
export interface DoctorOptions {
  /** The Node.js version to check. Defaults to the running one. */
  nodeVersion?: string;
  /** Where credentials are read from. Defaults to `process.env`. Only names are reported. */
  env?: Record<string, string | undefined>;
  /** Whether a package is installed. Defaults to resolving it from the working directory. */
  resolvePackage?: (name: string) => boolean;
  /** A database: connectivity, and migrations pending or changed. */
  database?: DoctorDatabase;
  /** A Redis client to ping. */
  redis?: { ping(): unknown };
  /** An operation store, read for leases that lapsed and a queue nobody drains. */
  operations?: {
    stats?(now: string): unknown;
    list?(): unknown;
  };
  /** How long the oldest queued operation may wait before the queue counts as stalled. Defaults to 15 minutes. */
  maxQueueAgeMs?: number;
  /** A client, read for provider health. */
  ai?: { getProviderHealth(): ReadonlyArray<{ providerName: string; healthy: boolean; stale?: boolean }> };
  /** How old the bundled model registry may be, in days. Defaults to the registry's own window. */
  registryMaxAgeDays?: number;
  /** How the application is deployed. */
  deployment?: DoctorDeployment;
  /** Replaces the clock, for tests. */
  now?: () => Date;
}

/** The optional peers, and what each is for. */
const PEERS: Record<string, string> = {
  openai: 'the OpenAI SDK, used only where an application passes one in',
  '@anthropic-ai/sdk': 'the Anthropic SDK, likewise',
  ollama: 'the Ollama client',
  zod: 'zod schemas for tools and structured output',
  ajv: 'JSON Schema validation of structured output',
  'ajv-formats': 'formats for ajv',
};

/** Environment variables that hold a provider's credentials, by provider. */
const CREDENTIALS: Record<string, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  'azure-openai': ['AZURE_OPENAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  cohere: ['COHERE_API_KEY', 'CO_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

/** Classes that keep their state in process memory, and what breaks behind several replicas. */
const PROCESS_LOCAL: Record<string, { status: DoctorStatus; why: string }> = {
  MemoryGraphCheckpointer: { status: 'fail', why: 'a thread started on one replica cannot be resumed on another' },
  MemoryOperationStore: { status: 'fail', why: 'operations and server runs are invisible to other replicas' },
  MemoryServerStore: { status: 'fail', why: 'threads and runs exist only on the replica that created them' },
  MemoryRunEventLog: { status: 'fail', why: 'a client reconnecting to another replica cannot follow its run' },
  MemoryTenantUsage: { status: 'fail', why: 'each replica counts its own tenant limits, multiplying them' },
  MemoryRateLimitStore: { status: 'warn', why: 'each replica enforces its own limit, multiplying it' },
  MemoryCircuitStateStore: { status: 'warn', why: 'a circuit opened on one replica stays closed on the others' },
  MemoryStore: { status: 'warn', why: 'long-term memory written on one replica is missing on the others' },
  MemoryTraceStore: { status: 'warn', why: 'each replica keeps only its own traces' },
  MemoryPromptStore: { status: 'warn', why: 'a prompt promoted on one replica is not served by the others' },
  MemoryCacheAdapter: { status: 'warn', why: 'each replica caches separately' },
  MemoryRollupStore: { status: 'warn', why: 'each replica sums only its own runs' },
};

/**
 * Runs every check its options allow and reports each, never throwing: a check that cannot run is a
 * failure with the reason.
 */
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorReport> {
  const now = options.now ?? (() => new Date());
  const checks: DoctorCheck[] = [];
  const run = async (
    id: string,
    title: string,
    check: () => Promise<Omit<DoctorCheck, 'id' | 'title'>> | Omit<DoctorCheck, 'id' | 'title'>,
  ) => {
    try {
      checks.push({ id, title, ...(await check()) });
    } catch (error) {
      checks.push({ id, title, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await run('node', 'Node.js version', () => nodeCheck(options.nodeVersion ?? process.versions.node));
  await run('peers', 'Optional packages', () => peersCheck(options.resolvePackage ?? defaultResolver()));
  await run('credentials', 'Provider credentials', () => credentialsCheck(options.env ?? process.env));
  await run('registry', 'Model registry age', () => registryCheck(now(), options.registryMaxAgeDays));
  await run('database', 'Database connectivity', () => databaseCheck(options.database));
  await run('migrations', 'Schema migrations', () => migrationsCheck(options.database));
  await run('redis', 'Redis', () => redisCheck(options.redis));
  await run('queue', 'Operation queue and leases', () => queueCheck(options.operations, now(), options.maxQueueAgeMs));
  await run('health', 'Provider health', () => healthCheck(options.ai));
  await run('topology', 'Settings that only work in one process', () => topologyCheck(options.deployment));
  await run('settings', 'Opt-in settings a deployment needs', () => settingsCheck(options.deployment));

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return { checks, ok: failures === 0, failures, warnings };
}

function nodeCheck(version: string): Omit<DoctorCheck, 'id' | 'title'> {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return major >= 22
    ? { status: 'ok', detail: `Node.js ${version}` }
    : { status: 'fail', detail: `Node.js ${version}; this package needs 22 or newer`, hint: 'Upgrade Node.js.' };
}

/** Resolves packages as the application in the working directory would. */
function defaultResolver(): (name: string) => boolean {
  const resolve = createRequire(path.join(process.cwd(), 'package.json')).resolve;
  return (name) => {
    try {
      resolve(name);
      return true;
    } catch {
      return false;
    }
  };
}

function peersCheck(resolve: (name: string) => boolean): Omit<DoctorCheck, 'id' | 'title'> {
  const installed = Object.keys(PEERS).filter((name) => resolve(name));
  const missing = Object.keys(PEERS).filter((name) => !installed.includes(name));
  return {
    status: 'ok',
    detail: `Installed: ${installed.length ? installed.join(', ') : 'none'}. Not installed: ${missing.length ? missing.join(', ') : 'none'}. Every one is optional; install only what you use.`,
  };
}

function credentialsCheck(env: Record<string, string | undefined>): Omit<DoctorCheck, 'id' | 'title'> {
  const found = Object.entries(CREDENTIALS)
    .filter(([, names]) => names.some((name) => Boolean(env[name]?.trim())))
    .map(([provider]) => provider);
  return found.length
    ? { status: 'ok', detail: `Credentials found for ${found.join(', ')}.` }
    : {
        status: 'warn',
        detail: 'No provider credential found in the environment.',
        hint: 'Set the API key of each hosted provider you use, such as OPENAI_API_KEY. Local providers need none.',
      };
}

async function registryCheck(now: Date, maxAgeDays: number | undefined): Promise<Omit<DoctorCheck, 'id' | 'title'>> {
  const { checkRegistryFreshness } = await import('../models/registry.js');
  const freshness = checkRegistryFreshness({ now, ...(maxAgeDays === undefined ? {} : { maxAgeDays }) });
  return freshness.stale
    ? {
        status: 'warn',
        detail: `The bundled registry was verified ${freshness.ageDays} days ago (${freshness.verifiedAt}), past its ${freshness.maxAgeDays}-day window.`,
        hint: 'Upgrade nexus-ai-pro, or override stale entries with models.registry.',
      }
    : { status: 'ok', detail: `Verified ${freshness.ageDays} days ago (${freshness.verifiedAt}).` };
}

function dialectOf(database: DoctorDatabase): 'postgres' | 'sqlite' {
  if (database.dialect) return database.dialect;
  const client = database.client as Record<string, unknown> | null;
  if (client && typeof client.query === 'function') return 'postgres';
  return 'sqlite';
}

async function databaseCheck(database: DoctorDatabase | undefined): Promise<Omit<DoctorCheck, 'id' | 'title'>> {
  if (!database) return { status: 'skip', detail: 'No database given.' };
  const dialect = dialectOf(database);
  if (dialect === 'postgres') {
    await (database.client as { query(text: string): Promise<unknown> }).query('SELECT 1');
  } else {
    const { toSqliteClient } = await import('../sqlite/client.js');
    await toSqliteClient(database.client as never).all('SELECT 1', []);
  }
  return { status: 'ok', detail: `Reached the ${dialect === 'postgres' ? 'Postgres' : 'SQLite'} database.` };
}

async function migrationsCheck(database: DoctorDatabase | undefined): Promise<Omit<DoctorCheck, 'id' | 'title'>> {
  if (!database) return { status: 'skip', detail: 'No database given.' };
  const dialect = dialectOf(database);
  const options = database.table ? { table: database.table } : {};
  let status: MigrationStatus;
  if (dialect === 'postgres') {
    const [{ postgresMigrations }, { postgresMigrationStatus }] = await Promise.all([
      import('../postgres/index.js'),
      import('../postgres/migrations.js'),
    ]);
    status = await postgresMigrationStatus(
      database.client as never,
      database.migrations ?? postgresMigrations(),
      options,
    );
  } else {
    const [{ sqliteMigrations }, { sqliteMigrationStatus }] = await Promise.all([
      import('../sqlite/index.js'),
      import('../sqlite/migrations.js'),
    ]);
    status = await sqliteMigrationStatus(database.client as never, database.migrations ?? sqliteMigrations(), options);
  }
  if (status.changed.length) {
    return {
      status: 'fail',
      detail: `${status.changed.length} migration${status.changed.length === 1 ? '' : 's'} changed after running: ${status.changed.map(({ migration }) => `${migration.component} v${migration.version}`).join(', ')}.`,
      hint: 'A migration never changes once applied. Check the adapter options match those it ran with.',
    };
  }
  if (status.pending.length) {
    return {
      status: 'fail',
      detail: `${status.pending.length} pending: ${status.pending.map((migration) => `${migration.component} v${migration.version}`).join(', ')}.`,
      hint: 'Run: nexus db migrate --client db.mjs',
    };
  }
  const newer = status.unknown.length ? ` ${status.unknown.length} recorded by a newer release.` : '';
  return { status: 'ok', detail: `${status.applied.length} applied, none pending.${newer}` };
}

async function redisCheck(redis: DoctorOptions['redis']): Promise<Omit<DoctorCheck, 'id' | 'title'>> {
  if (!redis) return { status: 'skip', detail: 'No Redis client given.' };
  const reply = await redis.ping();
  return { status: 'ok', detail: `PING answered ${String(reply)}.` };
}

async function queueCheck(
  operations: DoctorOptions['operations'],
  now: Date,
  maxQueueAgeMs = 15 * 60_000,
): Promise<Omit<DoctorCheck, 'id' | 'title'>> {
  if (!operations) return { status: 'skip', detail: 'No operation store given.' };
  const { operationStats } = await import('../operations/stats.js');
  const stats = await operationStats(operations as never, { now });
  const problems: string[] = [];
  if (stats.lapsedLeases > 0) {
    problems.push(
      `${stats.lapsedLeases} running operation${stats.lapsedLeases === 1 ? '' : 's'} hold a lease that lapsed`,
    );
  }
  const age = stats.oldestQueuedAt ? now.getTime() - Date.parse(stats.oldestQueuedAt) : 0;
  if (age > maxQueueAgeMs) problems.push(`the oldest queued operation has waited ${Math.round(age / 60_000)} minutes`);
  const counts = Object.entries(stats.byStatus)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  return problems.length
    ? {
        status: 'warn',
        detail: `${problems.join('; ')}. (${counts || 'nothing unfinished'})`,
        hint: 'Run recovery — OperationRunner.recover(), or the agent server with recoverEveryMs — and a worker that claims the queue.',
      }
    : { status: 'ok', detail: counts ? `Unfinished: ${counts}. No lapsed lease.` : 'Nothing unfinished.' };
}

function healthCheck(ai: DoctorOptions['ai']): Omit<DoctorCheck, 'id' | 'title'> {
  if (!ai) return { status: 'skip', detail: 'No client given.' };
  const snapshots = ai.getProviderHealth();
  if (snapshots.length === 0)
    return { status: 'skip', detail: 'Health tracking is off, or no provider has been called.' };
  const stale = snapshots.filter((item) => item.stale).map((item) => item.providerName);
  const unhealthy = snapshots.filter((item) => !item.healthy && !item.stale).map((item) => item.providerName);
  const issues = [
    ...(stale.length ? [`stale: ${stale.join(', ')}`] : []),
    ...(unhealthy.length ? [`unhealthy: ${unhealthy.join(', ')}`] : []),
  ];
  return issues.length
    ? {
        status: 'warn',
        detail: `${issues.join('; ')}.`,
        hint: 'Refresh stale entries with ai.checkProviders({ staleOnly: true }).',
      }
    : { status: 'ok', detail: `${snapshots.length} provider${snapshots.length === 1 ? '' : 's'} healthy.` };
}

function topologyCheck(deployment: DoctorDeployment | undefined): Omit<DoctorCheck, 'id' | 'title'> {
  if (!deployment) return { status: 'skip', detail: 'No deployment described.' };
  if (deployment.replicas <= 1)
    return { status: 'ok', detail: 'One replica: in-process state is shared by everything.' };
  const findings: Array<{ status: DoctorStatus; text: string }> = [];
  for (const [name, value] of Object.entries(deployment.stores ?? {})) {
    const kind = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
    const known = kind ? PROCESS_LOCAL[kind] : undefined;
    if (known) findings.push({ status: known.status, text: `${name} is a ${kind}: ${known.why}` });
  }
  if (findings.length === 0) {
    return { status: 'ok', detail: `${deployment.replicas} replicas, and nothing keeps its state in one process.` };
  }
  return {
    status: findings.some((finding) => finding.status === 'fail') ? 'fail' : 'warn',
    detail: `${deployment.replicas} replicas: ${findings.map((finding) => finding.text).join('; ')}.`,
    hint: 'Use the Redis, Postgres, or SQLite adapter for each, or run one replica.',
  };
}

/**
 * Settings that stay opt-in through 2.x, because turning them on changes what an upgrade does, but
 * that a deployment needs: found on the stores it describes, each with the setting that fixes it.
 */
function settingsCheck(deployment: DoctorDeployment | undefined): Omit<DoctorCheck, 'id' | 'title'> {
  const stores = Object.entries(deployment?.stores ?? {});
  if (stores.length === 0) return { status: 'skip', detail: 'No stores described.' };
  const findings: string[] = [];
  const hints = new Set<string>();
  for (const [name, value] of stores) {
    const kind = kindOf(value);
    if (kind === 'RedisOperationStore' && (value as { indexed?: unknown }).indexed === false) {
      findings.push(
        `${name} is a RedisOperationStore without index: true, so finding queued work reads every record and a long queue slows every claim`,
      );
      hints.add(
        'Give the Redis operation store index: true once every worker sharing its prefix runs 2.2 or later, then call reindex() once.',
      );
    }
    if (kind === 'Tracer') {
      const tracer = value as { incremental?: unknown; store?: unknown };
      const store = kindOf(tracer.store);
      if (tracer.incremental === false && store && store !== 'MemoryTraceStore') {
        findings.push(
          `${name} writes to a ${store} without incremental, so a trace is written when its root finishes and a replica that dies mid-run loses it`,
        );
        hints.add(
          'Create the Tracer with incremental: true, and close what a dead process left with closeAbandonedRuns().',
        );
      }
    }
  }
  if (findings.length === 0) return { status: 'ok', detail: 'No store lacks a setting a deployment needs.' };
  return { status: 'warn', detail: `${findings.join('; ')}.`, hint: [...hints].join(' ') };
}

function kindOf(value: unknown): string | undefined {
  return (value as { constructor?: { name?: string } } | null)?.constructor?.name;
}
