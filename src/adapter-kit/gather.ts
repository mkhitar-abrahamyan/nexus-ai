/**
 * Compatibility records gathered from where adapters' own CI publishes them: packages found on npm by
 * a keyword, each naming its record's URL in its `package.json`, and sources listed by hand. Each
 * record is read as `nexus adapters verify` sealed it, and must name the package that points to it.
 * Nothing an adapter publishes is run: a gathered record is listed as its CI recorded it.
 */
import { type CompatibilityRecord, readCompatibilityRecord } from './record.js';

/** The npm keyword an adapter package carries to be found: `nexus-ai-pro-adapter`. */
export const ADAPTER_KEYWORD = 'nexus-ai-pro-adapter';

/** Where one adapter's CI publishes its record. */
export interface RecordSource {
  /** The adapter's package name, which its record must name. */
  package: string;
  /** The record's URL: HTTPS, or HTTP to this machine. */
  url: string;
}

/** Options for `gatherRecords()`. */
export interface GatherRecordsOptions {
  /**
   * The keyword adapter packages are found by on npm, each naming its record's URL as
   * `nexus.compatibility` in its `package.json`. Defaults to `ADAPTER_KEYWORD`; `false` finds none.
   */
  keyword?: string | false;
  /** Sources listed by hand, beside those found; a listed package's URL is used over its own. */
  sources?: readonly RecordSource[];
  /** The npm registry. Defaults to `https://registry.npmjs.org`. */
  registry?: string;
  /**
   * The records gathered last time: a package whose record cannot be read now, because its source is
   * down or what it serves is refused, keeps its last one, and says why.
   */
  previous?: readonly CompatibilityRecord[];
  /** The most bytes a record may have. Defaults to 1 MiB. */
  maxBytes?: number;
  /** How long each request may take, in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** The most packages found by keyword. Defaults to 1,000. */
  maxPackages?: number;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * What became of one package's record: `gathered` now; `kept` from last time, as now it could not be;
 * `refused` or `unreachable` with nothing to keep; or `undeclared`, a package that names no record.
 */
export type GatherOutcome = 'gathered' | 'kept' | 'refused' | 'unreachable' | 'undeclared';

/** One package's source, and what became of its record. */
export interface GatheredSource {
  /** The package's name. */
  package: string;
  /** Where its record is published, when it says. */
  url?: string;
  /** What became of it. */
  outcome: GatherOutcome;
  /** Why, for every outcome but `gathered`. */
  detail?: string;
  /** The record listed for it: gathered now, or kept. */
  record?: CompatibilityRecord;
}

/** What `gatherRecords()` found. */
export interface GatherReport {
  /** Every record to list, gathered now or kept, by package name. */
  records: CompatibilityRecord[];
  /** Every package, by name, and what became of its record. */
  sources: GatheredSource[];
}

/**
 * Gathers the compatibility records adapters' own CI publishes: finds adapter packages on npm by
 * `keyword`, reads where each publishes its record, and fetches each, with `sources` listed by hand.
 * A record is gathered only when it reads as sealed, with a digest that matches it, and names the
 * package that points to it; a package whose record cannot be read now keeps its `previous` one.
 * Throws when npm cannot be searched, rather than reporting every adapter gone.
 */
export async function gatherRecords(options: GatherRecordsOptions = {}): Promise<GatherReport> {
  const request = options.fetch ?? fetch;
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const get = (url: string) => request(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });

  const found = new Map<string, string | undefined>();
  const keyword = options.keyword === undefined ? ADAPTER_KEYWORD : options.keyword;
  if (keyword) {
    for (const name of await search(get, registry, keyword, options.maxPackages ?? 1_000)) found.set(name, undefined);
  }
  for (const source of options.sources ?? []) found.set(source.package, source.url);

  const previous = new Map<string, CompatibilityRecord>();
  for (const record of options.previous ?? []) {
    const name = record.adapter.package ? packageName(record.adapter.package) : undefined;
    if (name) previous.set(name, record);
  }

  const sources: GatheredSource[] = [];
  for (const name of [...found.keys()].sort()) {
    const listed = found.get(name);
    const result = await gatherOne(name, listed, { get, registry, maxBytes });
    const last = previous.get(name);
    // What cannot be read now keeps what was read before; a package that no longer names a record does not.
    if ((result.outcome === 'refused' || result.outcome === 'unreachable') && last) {
      sources.push({ ...result, outcome: 'kept', record: last, detail: `${result.outcome}: ${result.detail}` });
    } else sources.push(result);
  }
  return {
    records: sources.flatMap((source) => (source.record ? [source.record] : [])),
    sources,
  };
}

/** The name of a package from how a record names it, such as `@acme/nexus-milvus` from `@acme/nexus-milvus@0.3.0`. */
export function packageName(specifier: string): string {
  const at = specifier.lastIndexOf('@');
  return at > 0 ? specifier.slice(0, at) : specifier;
}

/** The packages npm lists under a keyword, a page at a time. */
async function search(
  get: (url: string) => Promise<Response>,
  registry: string,
  keyword: string,
  limit: number,
): Promise<string[]> {
  const names: string[] = [];
  for (let from = 0; names.length < limit; ) {
    const url = `${registry}/-/v1/search?text=keywords:${encodeURIComponent(keyword)}&size=250&from=${from}`;
    let page: { objects?: Array<{ package?: { name?: unknown } }>; total?: number };
    try {
      const response = await get(url);
      if (!response.ok) throw new Error(`it answered ${response.status}`);
      page = (await response.json()) as typeof page;
    } catch (error) {
      throw new Error(`npm could not be searched for "${keyword}": ${message(error)}`);
    }
    const objects = page.objects ?? [];
    for (const item of objects) if (typeof item.package?.name === 'string') names.push(item.package.name);
    from += objects.length;
    if (objects.length === 0 || from >= (page.total ?? 0)) break;
  }
  return [...new Set(names)].slice(0, limit);
}

/** One package's record: where it is published, fetched, and checked. */
async function gatherOne(
  name: string,
  listed: string | undefined,
  context: { get: (url: string) => Promise<Response>; registry: string; maxBytes: number },
): Promise<GatheredSource> {
  let url = listed;
  if (url === undefined) {
    try {
      const response = await context.get(`${context.registry}/${name.replace('/', '%2f')}/latest`);
      if (!response.ok) return { package: name, outcome: 'unreachable', detail: `npm answered ${response.status}` };
      const manifest = (await response.json()) as { nexus?: { compatibility?: unknown } };
      const declared = manifest.nexus?.compatibility;
      if (typeof declared !== 'string' || !declared.trim()) {
        return { package: name, outcome: 'undeclared', detail: 'its package.json names no nexus.compatibility record' };
      }
      url = declared.trim();
    } catch (error) {
      return { package: name, outcome: 'unreachable', detail: `npm could not be read: ${message(error)}` };
    }
  }
  if (!allowed(url)) return { package: name, url, outcome: 'refused', detail: `${url} is not HTTPS` };
  let text: string;
  try {
    const response = await context.get(url);
    if (response.url && !allowed(response.url)) {
      return {
        package: name,
        url,
        outcome: 'refused',
        detail: `${url} redirects to ${response.url}, which is not HTTPS`,
      };
    }
    if (!response.ok)
      return { package: name, url, outcome: 'unreachable', detail: `${url} answered ${response.status}` };
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > context.maxBytes) return tooLarge(name, url, declared, context.maxBytes);
    text = await response.text();
  } catch (error) {
    return { package: name, url, outcome: 'unreachable', detail: `${url} could not be read: ${message(error)}` };
  }
  const size = new TextEncoder().encode(text).length;
  if (size > context.maxBytes) return tooLarge(name, url, size, context.maxBytes);
  let record: CompatibilityRecord;
  try {
    record = readCompatibilityRecord(text);
  } catch (error) {
    return { package: name, url, outcome: 'refused', detail: message(error) };
  }
  const named = record.adapter.package;
  if (!named) return { package: name, url, outcome: 'refused', detail: 'the record names no package' };
  if (packageName(named) !== name) {
    return { package: name, url, outcome: 'refused', detail: `the record names ${named}, not ${name}` };
  }
  return { package: name, url, outcome: 'gathered', record };
}

/** HTTPS anywhere, or HTTP to this machine, such as a stand-in in a test. */
function allowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function tooLarge(name: string, url: string, size: number, limit: number): GatheredSource {
  return {
    package: name,
    url,
    outcome: 'refused',
    detail: `the record is ${size} bytes, over the ${limit}-byte limit`,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
