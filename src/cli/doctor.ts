import { type DoctorOptions, type DoctorReport, diagnose } from '../doctor/index.js';
import { flagBool, isRecord, loadModule, numberFlag, type ParsedArgs, stringFlag, writeJson } from './args.js';

const LABELS = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' } as const;

/**
 * `nexus doctor` checks a deployment and exits 1 when a check fails, or with `--strict` when one
 * warns. Without `--module` it checks what it can see from the shell: Node.js, packages, credentials,
 * and the model registry. A module reaches the rest, exporting any of:
 *
 * ```js
 * // doctor.mjs
 * export const database = { client: pool };       // or `client` alone, as for nexus db
 * export const redis = new Redis(process.env.REDIS_URL);
 * export const operations = new PostgresOperationStore(pool);
 * export const ai = client;
 * export const deployment = { replicas: 3, stores: { checkpointer, state, tenantUsage } };
 * export const close = async () => { await pool.end(); redis.disconnect(); };
 * ```
 */
export async function runDoctorCommand({ flags }: ParsedArgs): Promise<void> {
  const location = stringFlag(flags, 'module');
  const loaded = location ? await loadModule(location) : {};
  const options: DoctorOptions = {};
  // A database module written for `nexus db` works here unchanged: its `client` is the database.
  const source = isRecord(loaded.database) ? loaded.database : loaded.client ? loaded : undefined;
  if (source?.client) {
    options.database = {
      client: source.client,
      ...(source.dialect === 'postgres' || source.dialect === 'sqlite' ? { dialect: source.dialect } : {}),
      ...(Array.isArray(source.migrations) ? { migrations: source.migrations as never } : {}),
      ...(typeof source.table === 'string' ? { table: source.table } : {}),
    };
  }
  if (loaded.redis) options.redis = loaded.redis as never;
  if (loaded.operations) options.operations = loaded.operations as never;
  if (loaded.ai) options.ai = loaded.ai as never;
  if (isRecord(loaded.deployment)) options.deployment = loaded.deployment as never;
  const replicas = numberFlag(flags, 'replicas');
  if (replicas !== undefined) options.deployment = { ...options.deployment, replicas };
  const maxQueueAgeMs = numberFlag(flags, 'max-queue-age-ms');
  if (maxQueueAgeMs !== undefined) options.maxQueueAgeMs = maxQueueAgeMs;

  let report: DoctorReport;
  try {
    report = await diagnose(options);
  } finally {
    if (typeof loaded.close === 'function') await (loaded.close as () => unknown)();
  }

  if (flagBool(flags, 'json')) writeJson(report);
  else print(report);
  if (!report.ok || (flagBool(flags, 'strict') && report.warnings > 0)) process.exitCode = 1;
}

function print(report: DoctorReport): void {
  for (const check of report.checks) {
    console.log(`${LABELS[check.status]}  ${check.title}: ${check.detail}`);
    if (check.hint && (check.status === 'fail' || check.status === 'warn')) console.log(`      ${check.hint}`);
  }
  console.log(
    `\n${report.failures} failed, ${report.warnings} warned, ${report.checks.length - report.failures - report.warnings} passed or skipped.`,
  );
}
