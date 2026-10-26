import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADAPTER_KEYWORD, gatherRecords, type RecordSource } from '../adapter-kit/gather.js';
import type { Adapter } from '../adapter-kit/index.js';
import {
  type CompatibilityRecord,
  type CompatibilityRecordOptions,
  compareRecords,
  compatibilityPage,
  readCompatibilityRecord,
  recordStatus,
} from '../adapter-kit/record.js';
import { CliUsageError, flagBool, isRecord, type ParsedArgs, printTable, stringFlag, writeJson } from './args.js';

/** What a verification module exports: the adapter, and what `verify()` needs to run it. */
interface VerificationModule {
  adapter: Adapter<unknown, unknown, unknown, unknown>;
  config?: unknown;
  options?: unknown;
  record?: CompatibilityRecordOptions;
  close?: () => unknown;
}

/**
 * `nexus adapters verify <module>[#export]`, `nexus adapters page <records...>`,
 * `nexus adapters recheck <records...>`, and `nexus adapters gather --out <dir>`.
 *
 * `verify` runs an adapter's contract suite and benchmark from its own repository and writes its
 * compatibility record; `page` lists records on one page; `recheck` verifies each listed adapter again
 * against the installed release and fails when one that passed no longer does; `gather` fetches the
 * records adapters' own CI publishes, checked and never run, into a directory a page lists.
 */
export async function runAdaptersCommand(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
  if (subcommand === 'verify') return verify(args);
  if (subcommand === 'page') return page(args);
  if (subcommand === 'recheck') return recheck(args);
  if (subcommand === 'gather') return gather(args);
  throw new CliUsageError(`Unknown adapters command "${subcommand ?? ''}". Use verify, page, recheck, or gather.`);
}

/**
 * Gathers the records adapters' own CI publishes into `--out`: one file per package, the last good
 * record kept for a package whose record cannot be read now, and a record no longer published removed.
 */
async function gather(args: ParsedArgs): Promise<void> {
  const out = stringFlag(args.flags, 'out');
  if (!out) throw new CliUsageError('nexus adapters gather needs --out <dir>: where the gathered records are kept.');
  const sourcesFile = stringFlag(args.flags, 'sources');
  const sources = sourcesFile ? sourcesFrom(await readFile(sourcesFile, 'utf8'), sourcesFile) : [];
  // What was gathered last time, read leniently: a file that is not a record is left alone.
  const previous: Array<{ file: string; record: CompatibilityRecord }> = [];
  for (const name of existsSync(out) ? (await readdir(out)).sort() : []) {
    if (!name.endsWith('.json')) continue;
    try {
      previous.push({ file: name, record: readCompatibilityRecord(await readFile(path.join(out, name), 'utf8')) });
    } catch {
      // Not a record: not ours to keep or remove.
    }
  }
  const registry = stringFlag(args.flags, 'registry');
  const report = await gatherRecords({
    keyword: args.flags.keyword === false ? false : (stringFlag(args.flags, 'keyword') ?? ADAPTER_KEYWORD),
    sources,
    previous: previous.map((entry) => entry.record),
    ...(registry ? { registry } : {}),
  });
  await mkdir(out, { recursive: true });
  const written = new Set<string>();
  for (const source of report.sources) {
    if (!source.record) continue;
    const file = `${slug(source.package)}.json`;
    written.add(file);
    await writeFile(
      path.join(out, file),
      `${JSON.stringify(source.record, null, 2)}
`,
    );
  }
  for (const { file } of previous) if (!written.has(file)) await rm(path.join(out, file));
  if (flagBool(args.flags, 'json')) {
    writeJson(report);
    return;
  }
  printTable(
    report.sources.map((source) => ({
      package: source.package,
      outcome: source.outcome,
      state: source.record ? recordStatus(source.record).state : '',
      detail: source.detail ?? '',
    })),
    ['package', 'outcome', 'state', 'detail'],
  );
  console.log('');
  console.log(`${report.records.length} records listed in ${out}, of ${report.sources.length} packages.`);
}

/** Sources listed by hand: a JSON array of `{ package, url }`. */
function sourcesFrom(text: string, file: string): RecordSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(`${file} is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new CliUsageError(`${file} must list sources: [{ "package": ..., "url": ... }]`);
  return parsed.map((item, index) => {
    if (!isRecord(item) || typeof item.package !== 'string' || typeof item.url !== 'string') {
      throw new CliUsageError(`${file}, source ${index + 1}: each source names its "package" and its record's "url"`);
    }
    return { package: item.package, url: item.url };
  });
}

async function verify(args: ParsedArgs): Promise<void> {
  const [target] = args.positionals;
  if (!target)
    throw new CliUsageError('nexus adapters verify needs a module: nexus adapters verify ./verify.mjs[#export].');
  const out = stringFlag(args.flags, 'out');
  const [specifier, exportName] = splitTarget(target);
  // A path is recorded relative to where the record is written, so `recheck` finds it from there.
  const recorded =
    stringFlag(args.flags, 'verify') ??
    (isPath(specifier, process.cwd()) && out
      ? relativeTo(path.dirname(path.resolve(out)), path.resolve(specifier))
      : specifier) + (exportName ? `#${exportName}` : '');
  const record = await recordOf(await importVerification(specifier, exportName, process.cwd()), {
    verify: recorded,
    ...(stringFlag(args.flags, 'package') ? { package: stringFlag(args.flags, 'package') } : {}),
    ...(stringFlag(args.flags, 'repository') ? { repository: stringFlag(args.flags, 'repository') } : {}),
  });
  if (out) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (!record.passed) process.exitCode = 1;
  if (flagBool(args.flags, 'json')) {
    writeJson(record);
    return;
  }
  printTable(
    record.checks.map((check) => ({
      check: check.name,
      result: check.skipped ? 'skipped' : check.ok ? 'held' : 'FAILED',
      detail: check.detail ?? '',
    })),
    ['check', 'result', 'detail'],
  );
  console.log('');
  console.log(
    `${record.adapter.name}@${record.adapter.version} ${record.passed ? 'passed' : 'did not pass'} the ${record.adapter.kind} contract v${record.contract.version} against nexus-ai-pro ${record.nexusVersion}${out ? `; record written to ${out}` : ''}.`,
  );
}

async function page(args: ParsedArgs): Promise<void> {
  const loaded = await readRecords(args.positionals);
  const records = loaded.map((entry) => entry.record);
  const text = compatibilityPage(records, {
    format: flagBool(args.flags, 'html') ? 'html' : 'markdown',
    ...(stringFlag(args.flags, 'title') ? { title: stringFlag(args.flags, 'title') } : {}),
    ...(stringFlag(args.flags, 'intro') ? { intro: stringFlag(args.flags, 'intro') } : {}),
  });
  const expect = stringFlag(args.flags, 'expect');
  const out = stringFlag(args.flags, 'out');
  if (expect) {
    const current = await readFile(expect, 'utf8').catch(() => undefined);
    if (current?.replace(/\r\n/g, '\n') !== text) {
      process.exitCode = 1;
      console.log(`${expect} does not list these records as they are: write it again with --out ${expect}.`);
    }
  } else if (out) await writeFile(out, text);
  else process.stdout.write(text);

  const strict = flagBool(args.flags, 'strict');
  if (flagBool(args.flags, 'check') || strict) {
    const red = records
      .map((record) => ({ record, status: recordStatus(record) }))
      .filter(
        ({ status }) =>
          status.state === 'failing' || status.state === 'incompatible' || (strict && status.state === 'stale'),
      );
    for (const { record, status } of red)
      console.log(`${record.adapter.name}: ${status.state}: ${status.reasons.join('; ')}`);
    if (red.length > 0) process.exitCode = 1;
  }
}

async function recheck(args: ParsedArgs): Promise<void> {
  const loaded = await readRecords(args.positionals);
  const out = stringFlag(args.flags, 'out');
  const update = flagBool(args.flags, 'update');
  const results: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, string>> = [];
  let regressed = false;
  for (const { file, record: listed } of loaded) {
    const name = `${listed.adapter.name}@${listed.adapter.version}`;
    if (!listed.adapter.verify) {
      rows.push({
        adapter: name,
        listed: describe(listed),
        now: '',
        result: 'skipped',
        detail: 'the record names no verify module',
      });
      results.push({ adapter: listed.adapter.name, skipped: true });
      continue;
    }
    let current: CompatibilityRecord;
    try {
      const [specifier, exportName] = splitTarget(listed.adapter.verify);
      const verification = await importVerification(specifier, exportName, path.dirname(path.resolve(file)));
      current = await recordOf(verification, {
        verify: listed.adapter.verify,
        ...(listed.adapter.package ? { package: listed.adapter.package } : {}),
        ...(listed.adapter.repository ? { repository: listed.adapter.repository } : {}),
      });
    } catch (error) {
      regressed ||= listed.passed;
      const detail = error instanceof Error ? error.message : String(error);
      rows.push({ adapter: name, listed: describe(listed), now: '', result: 'COULD NOT RUN', detail });
      results.push({ adapter: listed.adapter.name, error: detail });
      continue;
    }
    const comparison = compareRecords(listed, current);
    regressed ||= comparison.regressed;
    const failingAdded = comparison.added.filter((check) => !check.ok);
    rows.push({
      adapter: name,
      listed: describe(listed),
      now: describe(current),
      result: comparison.regressed ? 'REGRESSED' : current.passed ? 'passing' : 'failing',
      detail: [
        ...comparison.broken.map((check) => `no longer ${check.name}${check.detail ? ` (${check.detail})` : ''}`),
        ...failingAdded.map(
          (check) => `fails the new check “${check.name}”${check.detail ? ` (${check.detail})` : ''}`,
        ),
        ...comparison.fixed.map((name_) => `now ${name_}`),
        ...comparison.slower.map((entry) => `${entry.operation} p95 ${entry.beforeMs} ms to ${entry.afterMs} ms`),
      ].join('; '),
    });
    results.push({ adapter: listed.adapter.name, record: current, comparison });
    if (out) {
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, `${slug(listed.adapter.name)}.json`), `${JSON.stringify(current, null, 2)}\n`);
    }
    if (update) await writeFile(file, `${JSON.stringify(current, null, 2)}\n`);
  }
  if (regressed) process.exitCode = 1;
  if (flagBool(args.flags, 'json')) {
    writeJson({ regressed, results });
    return;
  }
  printTable(rows, ['adapter', 'listed', 'now', 'result', 'detail']);
  if (regressed) {
    console.log('');
    console.log('An adapter that passed its record does not pass against this release.');
  }
}

/** Runs a verification module's adapter and seals what it found. */
async function recordOf(
  verification: VerificationModule,
  options: CompatibilityRecordOptions,
): Promise<CompatibilityRecord> {
  try {
    const config = typeof verification.config === 'function' ? await verification.config() : verification.config;
    const verifyOptions =
      typeof verification.options === 'function' ? await verification.options() : verification.options;
    return await verification.adapter.record(config, verifyOptions ?? {}, { ...verification.record, ...options });
  } finally {
    await verification.close?.();
  }
}

/** Loads a verification module: a path, relative to `from`, or a package specifier. */
async function importVerification(
  specifier: string,
  exportName: string | undefined,
  from: string,
): Promise<VerificationModule> {
  let loaded: Record<string, unknown>;
  if (isPath(specifier, from))
    loaded = (await import(pathToFileURL(path.resolve(from, specifier)).href)) as Record<string, unknown>;
  else {
    try {
      loaded = (await import(
        pathToFileURL(createRequire(path.join(from, 'noop.js')).resolve(specifier)).href
      )) as Record<string, unknown>;
    } catch {
      // A package that exports only for `import` is found the way this command's own imports are.
      loaded = (await import(specifier)) as Record<string, unknown>;
    }
  }
  const candidate = exportName
    ? loaded[exportName]
    : isRecord(loaded.default) && !loaded.adapter
      ? loaded.default
      : loaded;
  if (!isRecord(candidate) || !isAdapter(candidate.adapter)) {
    throw new CliUsageError(
      `${specifier}${exportName ? `#${exportName}` : ''} must export an adapter built with the adapter kit as \`adapter\`, with the \`config\` and \`options\` its verify() takes.`,
    );
  }
  return candidate as unknown as VerificationModule;
}

/** Every record named: files, and the `.json` files of directories. */
async function readRecords(paths: readonly string[]): Promise<Array<{ file: string; record: CompatibilityRecord }>> {
  if (paths.length === 0) throw new CliUsageError('Name the records: files, or directories of them.');
  const files: string[] = [];
  for (const entry of paths) {
    if ((await stat(entry)).isDirectory()) {
      for (const name of (await readdir(entry)).sort()) if (name.endsWith('.json')) files.push(path.join(entry, name));
    } else files.push(entry);
  }
  const records: Array<{ file: string; record: CompatibilityRecord }> = [];
  for (const file of files) {
    try {
      records.push({ file, record: readCompatibilityRecord(await readFile(file, 'utf8')) });
    } catch (error) {
      throw new CliUsageError(`${file}: ${(error as Error).message}`);
    }
  }
  return records;
}

function isAdapter(value: unknown): value is Adapter<unknown, unknown, unknown, unknown> {
  return isRecord(value) && typeof value.record === 'function' && typeof value.verify === 'function';
}

function splitTarget(target: string): [string, string | undefined] {
  const index = target.lastIndexOf('#');
  return index > 0 ? [target.slice(0, index), target.slice(index + 1)] : [target, undefined];
}

/** A path, by its look or because a file is there: `compatibility/verify.mjs` is a path, `@acme/x/verify` a package. */
function isPath(specifier: string, from: string): boolean {
  return specifier.startsWith('.') || path.isAbsolute(specifier) || existsSync(path.resolve(from, specifier));
}

function relativeTo(from: string, to: string): string {
  const relative = path.relative(from, to).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function describe(record: CompatibilityRecord): string {
  return `${record.nexusVersion}, contract v${record.contract.version}, ${record.passed ? 'passed' : 'failed'}`;
}

function slug(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-z0-9.-]+/gi, '-');
}
