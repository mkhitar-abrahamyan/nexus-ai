/**
 * Compatibility records: what an adapter's `verify()` proved, kept as a document anyone can read back
 * and check. A record names the contract version the adapter passed, the release of `nexus-ai-pro` it
 * passed against, how fast each operation was, and on what runtime, sealed with a digest. A page lists
 * every record, and a release that would break a listed adapter is caught by checking the adapter
 * again against it before it ships.
 */
import { sha256Hex } from '../utils/sha256.js';
import { NEXUS_VERSION } from '../version.js';
import { ADAPTER_CONTRACTS, type AdapterCheck } from './contracts.js';
import type { AdapterBenchmarkEntry, AdapterKind, AdapterReport } from './index.js';
import { satisfiesRange } from './semver.js';

/** The format every record declares, so a reader knows what it holds. */
export const COMPATIBILITY_RECORD_FORMAT = 'nexus-compatibility/1';

/** The adapter a record is of, as its definition declares it. */
export interface CompatibilityRecordAdapter {
  /** Its name, usually its package name. */
  name: string;
  /** Its version. */
  version: string;
  /** Its kind. */
  kind: AdapterKind;
  /** The releases of `nexus-ai-pro` it declares support for, as a range. */
  nexus: string;
  /** What it declares it can do. */
  capabilities: unknown;
  /** The p95 budgets it declares, in milliseconds. */
  budgets?: Readonly<Record<string, number>>;
  /** Where it is published, such as `@acme/nexus-milvus@0.3.0`. */
  package?: string;
  /** Its source repository. */
  repository?: string;
  /**
   * The module that verifies it, as `nexus adapters verify` loads one, so `nexus adapters recheck` can
   * verify it again: a path, or a package specifier such as `@acme/nexus-milvus/verify`.
   */
  verify?: string;
}

/** What an adapter's `verify()` proved, sealed. */
export interface CompatibilityRecord {
  /** `nexus-compatibility/1`. */
  format: typeof COMPATIBILITY_RECORD_FORMAT;
  /** The adapter. */
  adapter: CompatibilityRecordAdapter;
  /** The contract it was verified against: its kind and version. */
  contract: { kind: AdapterKind; version: number };
  /** The release of `nexus-ai-pro` it was verified against. */
  nexusVersion: string;
  /** ISO-8601 time it was verified. */
  verifiedAt: string;
  /** The runtime it was verified on, such as `node 24.21.0 linux x64`. */
  runtime: string;
  /** Whether that release is inside the adapter's declared range. */
  compatible: boolean;
  /** Whether it is compatible and every check that ran held. */
  passed: boolean;
  /** Every check, in order, skipped ones marked. */
  checks: AdapterCheck[];
  /** Latency per operation over the contract's calls. */
  benchmark: Record<string, AdapterBenchmarkEntry>;
  /** The SHA-256 of everything above, so an edited record is known for one. */
  digest: string;
}

/** What `compatibilityRecord()` adds to a report. */
export interface CompatibilityRecordOptions {
  /** Where the adapter is published. */
  package?: string;
  /** Its source repository. */
  repository?: string;
  /** The module that verifies it, for `nexus adapters recheck`. */
  verify?: string;
  /** The runtime, when not the one this runs on. */
  runtime?: string;
  /** Replaces the clock, for tests. */
  now?: () => Date;
}

/** Raised when a record cannot be read: not a record, of an unknown format, or edited after it was sealed. */
export class CompatibilityRecordError extends Error {
  constructor(
    message: string,
    /** Every problem found. */
    readonly issues: readonly string[] = [message],
  ) {
    super(message);
    this.name = 'CompatibilityRecordError';
  }
}

/** A record of what `verify()` reported, sealed with its digest. */
export function compatibilityRecord(
  report: AdapterReport,
  options: CompatibilityRecordOptions = {},
): CompatibilityRecord {
  const unsealed: Omit<CompatibilityRecord, 'digest'> = {
    format: COMPATIBILITY_RECORD_FORMAT,
    adapter: {
      name: report.adapter,
      version: report.version,
      kind: report.kind,
      nexus: report.nexusRange,
      capabilities: report.capabilities,
      ...(report.budgets ? { budgets: { ...report.budgets } } : {}),
      ...(options.package ? { package: options.package } : {}),
      ...(options.repository ? { repository: options.repository } : {}),
      ...(options.verify ? { verify: options.verify } : {}),
    },
    contract: { kind: report.kind, version: report.contractVersion },
    nexusVersion: report.nexusVersion,
    verifiedAt: (options.now?.() ?? new Date()).toISOString(),
    runtime: options.runtime ?? runtimeName(),
    compatible: report.compatible,
    passed: report.passed,
    checks: report.checks.map((check) => ({ ...check })),
    benchmark: Object.fromEntries(Object.entries(report.benchmark).map(([key, entry]) => [key, { ...entry }])),
  };
  return { ...unsealed, digest: recordDigest(unsealed) };
}

/** The digest a record is sealed with: the SHA-256 of its content, its keys in order, without the digest. */
export function recordDigest(record: Omit<CompatibilityRecord, 'digest'> | CompatibilityRecord): string {
  const { digest: _digest, ...content } = record as CompatibilityRecord;
  return sha256Hex(canonical(content));
}

/**
 * Reads a record, as JSON text or as an object, and checks it: its format, the fields every record
 * has, and its digest. Throws a `CompatibilityRecordError` listing every problem.
 */
export function readCompatibilityRecord(input: string | unknown): CompatibilityRecord {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new CompatibilityRecordError(`not JSON: ${(error as Error).message}`);
    }
  }
  if (!isRecord(value)) throw new CompatibilityRecordError('a compatibility record is an object');
  const issues: string[] = [];
  if (value.format !== COMPATIBILITY_RECORD_FORMAT) {
    issues.push(`format is ${JSON.stringify(value.format)}, not ${COMPATIBILITY_RECORD_FORMAT}`);
  }
  const adapter = isRecord(value.adapter) ? value.adapter : undefined;
  if (!adapter) issues.push('adapter is missing');
  else {
    for (const field of ['name', 'version', 'nexus'] as const) {
      if (typeof adapter[field] !== 'string' || !adapter[field]) issues.push(`adapter.${field} is missing`);
    }
    if (!(typeof adapter.kind === 'string' && Object.hasOwn(ADAPTER_CONTRACTS, adapter.kind))) {
      issues.push('adapter.kind is not a kind');
    }
  }
  const contract = isRecord(value.contract) ? value.contract : undefined;
  if (!contract || typeof contract.version !== 'number' || contract.kind !== adapter?.kind) {
    issues.push('contract names no version of the adapter’s kind');
  }
  for (const field of ['nexusVersion', 'verifiedAt', 'runtime', 'digest'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) issues.push(`${field} is missing`);
  }
  for (const field of ['compatible', 'passed'] as const) {
    if (typeof value[field] !== 'boolean') issues.push(`${field} is not true or false`);
  }
  if (
    !Array.isArray(value.checks) ||
    !value.checks.every((check) => isRecord(check) && typeof check.name === 'string' && typeof check.ok === 'boolean')
  ) {
    issues.push('checks is not a list of checks');
  }
  if (!isRecord(value.benchmark)) issues.push('benchmark is missing');
  if (issues.length === 0) {
    const record = value as unknown as CompatibilityRecord;
    if (recordDigest(record) !== record.digest)
      issues.push('the digest does not match: the record was changed after it was sealed');
    else if (record.passed !== (record.compatible && record.checks.every((check) => check.ok))) {
      issues.push('passed does not follow from its checks');
    }
  }
  if (issues.length > 0)
    throw new CompatibilityRecordError(`Not a valid compatibility record: ${issues.join('; ')}`, issues);
  return value as unknown as CompatibilityRecord;
}

/** Where a record stands against a release: what a page shows, and what a check gates on. */
export type CompatibilityState = 'passing' | 'failing' | 'incompatible' | 'stale';

/** A record's state against a release, and why. */
export interface CompatibilityStatus {
  /**
   * `failing` when a check did not hold; `incompatible` when the release is outside the adapter's
   * declared range; `stale` when it was verified against an older version of its contract;
   * `passing` otherwise.
   */
  state: CompatibilityState;
  /** Why, a sentence each. */
  reasons: string[];
  /** The checks its contract added since the version it was verified against. */
  unverified: string[];
}

/** Where a record stands against a release, the installed one by default. */
export function recordStatus(
  record: CompatibilityRecord,
  options: { nexusVersion?: string } = {},
): CompatibilityStatus {
  const nexusVersion = options.nexusVersion ?? NEXUS_VERSION;
  const contract = ADAPTER_CONTRACTS[record.adapter.kind];
  const unverified = contract.history
    .filter((version) => version.version > record.contract.version)
    .flatMap((version) => version.added);
  const failed = record.checks.filter((check) => !check.ok).map((check) => check.name);
  if (failed.length > 0 || !record.passed) {
    return {
      state: 'failing',
      reasons: failed.length > 0 ? failed.map((name) => `fails: ${name}`) : ['it did not pass'],
      unverified,
    };
  }
  if (!satisfiesRange(nexusVersion, record.adapter.nexus)) {
    return {
      state: 'incompatible',
      reasons: [`declares nexus-ai-pro ${record.adapter.nexus}, which leaves out ${nexusVersion}`],
      unverified,
    };
  }
  if (record.contract.version < contract.version) {
    return {
      state: 'stale',
      reasons: [
        `verified against ${record.adapter.kind} contract v${record.contract.version}; v${contract.version} adds ${unverified.map((name) => `“${name}”`).join(', ') || 'no checks'}`,
      ],
      unverified,
    };
  }
  return { state: 'passing', reasons: [], unverified };
}

/** One check whose outcome moved between two records of an adapter. */
export interface CheckChange {
  /** The check. */
  name: string;
  /** Why it fails now, when it does. */
  detail?: string;
}

/** What changed between an adapter's listed record and a record of it verified again. */
export interface CompatibilityComparison {
  /** The adapter. */
  adapter: string;
  /** Checks that held before and fail now. */
  broken: CheckChange[];
  /** Checks the listed record did not have, with whether each holds. */
  added: AdapterCheck[];
  /** Checks that failed before and hold now. */
  fixed: string[];
  /** Operations whose p95 more than doubled, with both. */
  slower: Array<{ operation: string; beforeMs: number; afterMs: number }>;
  /** True when the listed record passed and the new one does not: this release turns it red. */
  regressed: boolean;
}

/** Compares an adapter's listed record with one verified again, such as against a release candidate. */
export function compareRecords(listed: CompatibilityRecord, current: CompatibilityRecord): CompatibilityComparison {
  // The range check names the release it ran against; across releases it is the same check.
  const identity = (name: string) =>
    name.replace(/^declares support for nexus-ai-pro .+$/, 'declares support for nexus-ai-pro');
  const before = new Map(listed.checks.map((check) => [identity(check.name), check]));
  const broken: CheckChange[] = [];
  const added: AdapterCheck[] = [];
  const fixed: string[] = [];
  for (const check of current.checks) {
    const was = before.get(identity(check.name));
    if (!was) added.push({ ...check });
    else if (was.ok && !check.ok) broken.push({ name: check.name, ...(check.detail ? { detail: check.detail } : {}) });
    else if (!was.ok && check.ok) fixed.push(check.name);
  }
  const slower = Object.entries(current.benchmark)
    .map(([operation, entry]) => ({ operation, beforeMs: listed.benchmark[operation]?.p95Ms, afterMs: entry.p95Ms }))
    .filter(
      (entry): entry is { operation: string; beforeMs: number; afterMs: number } =>
        entry.beforeMs !== undefined && entry.beforeMs > 0 && entry.afterMs > entry.beforeMs * 2,
    );
  return { adapter: current.adapter.name, broken, added, fixed, slower, regressed: listed.passed && !current.passed };
}

/** Options for `compatibilityPage()`. */
export interface CompatibilityPageOptions {
  /** The page's title. Defaults to `Adapter compatibility`. */
  title?: string;
  /** A paragraph under the title. */
  intro?: string;
  /** The release each record's state is judged against. Defaults to the installed one. */
  nexusVersion?: string;
  /** `markdown`, the default, or `html`. */
  format?: 'markdown' | 'html';
}

/**
 * One page listing every record: each adapter, its kind and version, the release and contract it was
 * verified against, its state there, its checks, and its p95 per operation, by kind and name. The
 * same records make the same page, so it can be checked for drift.
 */
export function compatibilityPage(
  records: readonly CompatibilityRecord[],
  options: CompatibilityPageOptions = {},
): string {
  const nexusVersion = options.nexusVersion ?? NEXUS_VERSION;
  const sorted = [...records].sort(
    (a, b) => a.adapter.kind.localeCompare(b.adapter.kind) || a.adapter.name.localeCompare(b.adapter.name),
  );
  const rows = sorted.map((record) => {
    const status = recordStatus(record, { nexusVersion });
    const ran = record.checks.filter((check) => !check.skipped);
    const skipped = record.checks.length - ran.length;
    return {
      record,
      status,
      cells: [
        record.adapter.repository
          ? { text: record.adapter.name, href: record.adapter.repository }
          : { text: record.adapter.name },
        { text: record.adapter.kind },
        { text: record.adapter.version },
        { text: record.nexusVersion },
        { text: `v${record.contract.version}` },
        { text: status.state },
        { text: `${ran.filter((check) => check.ok).length}/${ran.length}${skipped ? `, ${skipped} skipped` : ''}` },
        {
          text:
            Object.entries(record.benchmark)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([operation, entry]) => `${operation} ${entry.p95Ms} ms`)
              .join(', ') || '—',
        },
        { text: `${record.verifiedAt.slice(0, 10)}, ${record.runtime}` },
      ],
    };
  });
  const headers = ['Adapter', 'Kind', 'Version', 'Verified against', 'Contract', 'State', 'Checks', 'p95', 'Verified'];
  const title = options.title ?? 'Adapter compatibility';
  const notes = rows.filter((row) => row.status.reasons.length > 0);

  if (options.format === 'html') {
    const cell = (item: { text: string; href?: string }) =>
      item.href ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.text)}</a>` : escapeHtml(item.text);
    return [
      '<!doctype html>',
      `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>`,
      `<h1>${escapeHtml(title)}</h1>`,
      ...(options.intro ? [`<p>${escapeHtml(options.intro)}</p>`] : []),
      `<p>States are judged against nexus-ai-pro ${escapeHtml(nexusVersion)}.</p>`,
      '<table>',
      `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>`,
      '<tbody>',
      ...rows.map(
        (row) =>
          `<tr data-state="${row.status.state}">${row.cells.map((item) => `<td>${cell(item)}</td>`).join('')}</tr>`,
      ),
      '</tbody></table>',
      ...(notes.length > 0
        ? [
            '<ul>',
            ...notes.map(
              (row) =>
                `<li><strong>${escapeHtml(row.record.adapter.name)}</strong>: ${row.status.reasons.map(escapeHtml).join('; ')}</li>`,
            ),
            '</ul>',
          ]
        : []),
      '</body></html>',
      '',
    ].join('\n');
  }

  const cell = (item: { text: string; href?: string }) => {
    const text = item.text.replace(/\|/g, '\\|');
    return item.href ? `[${text}](${item.href.replace(/\|/g, '%7C')})` : text;
  };
  return [
    `# ${title}`,
    '',
    ...(options.intro ? [options.intro, ''] : []),
    `States are judged against nexus-ai-pro ${nexusVersion}.`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.cells.map(cell).join(' | ')} |`),
    ...(notes.length > 0
      ? ['', ...notes.map((row) => `- **${row.record.adapter.name}**: ${row.status.reasons.join('; ')}`)]
      : []),
    '',
  ].join('\n');
}

function runtimeName(): string {
  const runtime = globalThis as {
    process?: { versions?: { node?: string; bun?: string }; platform?: string; arch?: string };
    Deno?: { version?: { deno?: string } };
  };
  if (runtime.Deno?.version?.deno) return `deno ${runtime.Deno.version.deno}`;
  if (runtime.process?.versions?.bun) return `bun ${runtime.process.versions.bun}`;
  if (runtime.process?.versions?.node) {
    return `node ${runtime.process.versions.node} ${runtime.process.platform ?? ''} ${runtime.process.arch ?? ''}`.trim();
  }
  return 'unknown runtime';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** JSON with every object's keys in order. */
function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item) =>
      isRecord(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    ) ?? 'undefined'
  );
}
