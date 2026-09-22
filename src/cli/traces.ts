import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatTree } from '../tracing/compare.js';
import { JsonlTraceStore } from '../tracing/stores.js';
import type { RunKind, RunQuery, RunStatus, TraceStore } from '../types/tracing.js';
import {
  CliUsageError,
  flagBool,
  isRecord,
  listFlag,
  loadModule,
  numberFlag,
  type ParsedArgs,
  printTable,
  stringFlag,
  writeJson,
} from './args.js';

/**
 * `nexus traces list | show | export`.
 *
 * `--store` names a JSONL trace file, or a module exporting any `TraceStore` as `store` — which is
 * how a Postgres store with the application's own pool is reached without the CLI knowing about it.
 */
export async function runTracesCommand(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
  const store = await openStore(stringFlag(args.flags, 'store'));
  if (subcommand === 'list') return list(store, args);
  if (subcommand === 'show') return show(store, args);
  if (subcommand === 'export') return exportRuns(store, args);
  throw new CliUsageError(`Unknown traces command "${subcommand ?? ''}". Use list, show, or export.`);
}

async function openStore(location: string | undefined): Promise<TraceStore> {
  if (!location) throw new CliUsageError('nexus traces needs --store <runs.jsonl | store.mjs>.');
  if (location.endsWith('.jsonl')) return new JsonlTraceStore({ file: path.resolve(location) });

  const loaded = await loadModule(location);
  const store = (loaded.store ?? loaded.default ?? loaded) as unknown;
  if (!isRecord(store) || typeof store.query !== 'function' || typeof store.tree !== 'function') {
    throw new CliUsageError(`${location} must export a trace store as \`store\`.`);
  }
  return store as unknown as TraceStore;
}

function queryOf(flags: ParsedArgs['flags'], defaultLimit: number): RunQuery {
  const kinds = listFlag(flags, 'kind') as RunKind[] | undefined;
  return {
    ...(stringFlag(flags, 'trace') ? { traceId: stringFlag(flags, 'trace') } : {}),
    ...(kinds ? { kind: kinds.length === 1 ? (kinds[0] as RunKind) : kinds } : {}),
    ...(stringFlag(flags, 'status') ? { status: stringFlag(flags, 'status') as RunStatus } : {}),
    ...(stringFlag(flags, 'name') ? { name: stringFlag(flags, 'name') } : {}),
    ...(stringFlag(flags, 'model') ? { model: stringFlag(flags, 'model') } : {}),
    ...(stringFlag(flags, 'provider') ? { provider: stringFlag(flags, 'provider') } : {}),
    ...(listFlag(flags, 'tags') ? { tags: listFlag(flags, 'tags') } : {}),
    ...(stringFlag(flags, 'since') ? { since: stringFlag(flags, 'since') } : {}),
    ...(stringFlag(flags, 'until') ? { until: stringFlag(flags, 'until') } : {}),
    ...(stringFlag(flags, 'feedback-key') ? { feedbackKey: stringFlag(flags, 'feedback-key') } : {}),
    ...(numberFlag(flags, 'min-latency-ms') === undefined ? {} : { minLatencyMs: numberFlag(flags, 'min-latency-ms') }),
    ...(numberFlag(flags, 'min-cost') === undefined ? {} : { minCost: numberFlag(flags, 'min-cost') }),
    limit: numberFlag(flags, 'limit') ?? defaultLimit,
    ...(numberFlag(flags, 'offset') === undefined ? {} : { offset: numberFlag(flags, 'offset') }),
  };
}

async function list(store: TraceStore, { flags }: ParsedArgs): Promise<void> {
  const runs = await store.query(queryOf(flags, 20));
  if (flagBool(flags, 'json')) {
    writeJson(runs);
    return;
  }
  if (runs.length === 0) {
    console.log('No runs match.');
    return;
  }
  printTable(
    runs.map((run) => ({
      started: run.startedAt,
      trace: run.traceId,
      kind: run.kind,
      name: run.name,
      status: run.status,
      latency: run.latencyMs === undefined ? '' : `${Math.round(run.latencyMs)}ms`,
      cost: run.cost === undefined ? '' : `$${run.cost.toFixed(6)}`,
    })),
    ['started', 'trace', 'kind', 'name', 'status', 'latency', 'cost'],
  );
}

async function show(store: TraceStore, { positionals, flags }: ParsedArgs): Promise<void> {
  const traceId = positionals[0];
  if (!traceId) throw new CliUsageError('nexus traces show needs a trace id.');
  const tree = await store.tree(traceId);
  if (!tree) throw new CliUsageError(`No trace "${traceId}" in the store.`);
  if (flagBool(flags, 'json')) writeJson(tree);
  else console.log(formatTree(tree));
}

/** Runs as JSONL, the format a dataset can be built from and every log tool can read. */
async function exportRuns(store: TraceStore, { flags }: ParsedArgs): Promise<void> {
  const runs = await store.query(queryOf(flags, 1_000));
  const jsonl = runs.map((run) => JSON.stringify(run)).join('\n') + (runs.length ? '\n' : '');
  const out = stringFlag(flags, 'out');
  if (!out) {
    process.stdout.write(jsonl);
    return;
  }
  await writeFile(path.resolve(out), jsonl, 'utf8');
  console.log(`Wrote ${runs.length} runs to ${out}`);
}
