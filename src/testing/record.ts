import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Record provider traffic once, replay it everywhere else.
 *
 * A conformance suite or an evaluation that needs live credentials runs where the credentials are —
 * which is rarely CI, and never a contributor's first checkout. Recording captures the real wire
 * traffic of one run into reviewable files; replay serves those files back, deterministically and
 * with no network, so the same suite runs on every pull request. Anything the recording did not
 * cover fails loudly instead of quietly reaching the live API.
 */

/** A recorded request, with credentials removed. */
export interface RecordedRequest {
  /** HTTP method. */
  method: string;
  /** URL, with credential query parameters removed and the query sorted. */
  url: string;
  /** Headers, with credential headers redacted. */
  headers: Record<string, string>;
  /** The body, as text or base64. */
  body?: string;
  /** How `body` is encoded. */
  bodyEncoding?: 'utf8' | 'base64';
}

/** A recorded response. */
export interface RecordedResponse {
  /** HTTP status code. */
  status: number;
  /** HTTP status text. */
  statusText?: string;
  /** Headers, without the transport headers `fetch` has already applied. */
  headers: Record<string, string>;
  /** The body, as text or base64. */
  body: string;
  /** How `body` is encoded. */
  bodyEncoding: 'utf8' | 'base64';
}

/** One request and the response it got, as written to a fixture file. */
export interface RecordedExchange {
  /** What the request is matched by on replay. */
  key: string;
  /** Position among recorded requests that share a key, for a request made several times. */
  index: number;
  /** The request, as recorded. */
  request: RecordedRequest;
  /** The response, as recorded. */
  response: RecordedResponse;
  /** ISO-8601 time it was recorded. */
  recordedAt: string;
}

/** What a matcher sees: the request, with credentials already removed. */
export interface MatchInput {
  /** HTTP method. */
  method: string;
  /** URL, credentials removed and query sorted. */
  url: string;
  /** Headers, credentials redacted. */
  headers: Record<string, string>;
  /** The body as text, with any multipart boundary normalized. */
  body?: string;
}

/** Where fixtures live and how requests are matched to them. */
export interface FixtureOptions {
  /** Directory the fixture files live in, one file per exchange. */
  directory: string;
  /**
   * How a request is matched to a recording. Defaults to a hash of the method, the URL with its
   * query sorted, and the body with object keys sorted. Override it to ignore a field that changes
   * on every call, such as a timestamp in the body.
   */
  match?: (request: MatchInput) => string;
  /** Top-level JSON body fields left out of the default match: a request id, a timestamp. */
  ignoreBodyFields?: readonly string[];
  /** Header names removed from recordings, in addition to the credential headers always removed. */
  redactHeaders?: readonly string[];
  /** Query parameters removed from recorded URLs, in addition to the credential ones always removed. */
  redactQuery?: readonly string[];
}

/** Options for recording. */
export interface RecordOptions extends FixtureOptions {
  /** The real fetch. Defaults to `globalThis.fetch` at the time of the call. */
  fetch?: typeof globalThis.fetch;
  /**
   * Last chance to rewrite an exchange before it is written: personal data in a prompt, a long body.
   * Credentials are already gone by then; this is for everything else, and a PII detector from
   * `nexus-ai-pro/security` plugs in here.
   */
  redact?: (exchange: RecordedExchange) => RecordedExchange;
  /** Replaces the system clock, for `recordedAt`. */
  now?: () => Date;
}

/** Options for replaying. */
export interface ReplayOptions extends FixtureOptions {
  /**
   * What an unrecorded request does. `throw` (the default) raises `FixtureMissingError`; `live`
   * sends it to the real API through `fetch`, and is only for deliberately topping up recordings.
   */
  onMissing?: 'throw' | 'live';
  /** The real fetch, for `onMissing: 'live'`. */
  fetch?: typeof globalThis.fetch;
}

/** A fetch that also lets a test wait for every fixture it has written. */
export type RecordingFetch = typeof globalThis.fetch & { flush(): Promise<void> };

/** Raised on replay when no recording matches a request. */
export class FixtureMissingError extends Error {
  constructor(
    /** HTTP method of the unmatched request. */
    readonly method: string,
    /** URL of the unmatched request. */
    readonly url: string,
    /** The match key it had, for finding the fixture that should have matched. */
    readonly key: string,
    directory: string,
  ) {
    super(
      `No recorded response for ${method} ${url} (key ${key}) in ${directory}. Record it by running with fixtures in record mode, or allow live calls explicitly.`,
    );
    this.name = 'FixtureMissingError';
  }
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

const CREDENTIAL_HEADER = /authorization|api[-_]?key|token|secret|cookie|signature|password|session/i;
const CREDENTIAL_QUERY = new Set(['key', 'api_key', 'apikey', 'token', 'access_token', 'sig', 'signature', 'code']);
const REDACTED = '[REDACTED]';

/** Wraps a real fetch so that every exchange is written to the fixture directory. */
export function recordingFetch(options: RecordOptions): RecordingFetch {
  const counters = new Map<string, number>();
  const writes = new Set<Promise<void>>();
  const now = options.now ?? (() => new Date());

  const recording = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    // Captured from a copy; the real fetch gets the caller's own arguments, untouched, so a fetch
    // that reads `init` directly still sees them. A one-shot stream body cannot be both, and is not
    // supported.
    const captured = await captureRequest(copyOf(input, init), options);
    const real = options.fetch ?? globalThis.fetch;
    const response = await real(input, init);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const index = counters.get(captured.key) ?? 0;
    counters.set(captured.key, index + 1);

    let exchange: RecordedExchange = {
      key: captured.key,
      index,
      request: captured.request,
      response: {
        status: response.status,
        ...(response.statusText ? { statusText: response.statusText } : {}),
        headers: withoutTransportHeaders(redactHeaders(response.headers, options.redactHeaders)),
        ...encodeBody(bytes, response.headers.get('content-type')),
      },
      recordedAt: now().toISOString(),
    };
    if (options.redact) exchange = options.redact(exchange);

    const write = writeExchange(options.directory, exchange).finally(() => writes.delete(write));
    writes.add(write);

    // The caller gets the same bytes the provider sent, as a fresh response it can still read.
    return new Response(isNullBodyStatus(response.status) ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as RecordingFetch;

  recording.flush = async () => {
    await Promise.all([...writes]);
  };
  return recording;
}

/** Serves recorded exchanges instead of calling the network. */
export function replayFetch(options: ReplayOptions): typeof globalThis.fetch {
  let loaded: Promise<Map<string, RecordedExchange[]>> | undefined;
  const served = new Map<string, number>();

  return (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const request = copyOf(input, init);
    request.signal?.throwIfAborted();
    const captured = await captureRequest(request, options);
    loaded ??= loadExchanges(options.directory);
    const recordings = (await loaded).get(captured.key);

    if (!recordings?.length) {
      if (options.onMissing === 'live') return (options.fetch ?? globalThis.fetch)(input, init);
      throw new FixtureMissingError(request.method, captured.request.url, captured.key, options.directory);
    }

    // Repeated identical requests replay in the order they were recorded, then repeat the last,
    // which is what a polling loop needs.
    const position = served.get(captured.key) ?? 0;
    served.set(captured.key, position + 1);
    const exchange = recordings[Math.min(position, recordings.length - 1)] as RecordedExchange;
    const body =
      exchange.response.bodyEncoding === 'base64'
        ? Buffer.from(exchange.response.body, 'base64')
        : exchange.response.body;
    return new Response(isNullBodyStatus(exchange.response.status) ? null : body, {
      status: exchange.response.status,
      statusText: exchange.response.statusText ?? '',
      headers: exchange.response.headers,
    });
  }) as typeof globalThis.fetch;
}

/** `record` captures live traffic, `replay` serves fixtures, `live` passes through untouched. */
export type FixtureMode = 'record' | 'replay' | 'live';

/**
 * Picks recording, replay, or the live network by mode, so one test file serves all three. Defaults
 * to the `NEXUS_FIXTURES` environment variable, then to `replay`.
 */
export function fixtureFetch(
  options: RecordOptions & ReplayOptions & { mode?: FixtureMode },
): typeof globalThis.fetch & { flush?: () => Promise<void> } {
  const mode = options.mode ?? (process.env.NEXUS_FIXTURES as FixtureMode | undefined) ?? 'replay';
  if (mode === 'record') return recordingFetch(options);
  if (mode === 'live') return options.fetch ?? ((...args) => globalThis.fetch(...args));
  if (mode === 'replay') return replayFetch(options);
  throw new RangeError(`Unknown fixture mode "${mode}"; use record, replay, or live`);
}

/**
 * Replaces `globalThis.fetch` until the returned function is called, for code that does not take a
 * `fetch` option — several completion providers call the global directly.
 */
export function installFetch(replacement: typeof globalThis.fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  return () => {
    globalThis.fetch = original;
  };
}

/** Reads every exchange in a fixture directory, for inspection or a custom replay. */
export async function readFixtures(directory: string): Promise<RecordedExchange[]> {
  return [...(await loadExchanges(directory)).values()].flat();
}

/** A request to read from, leaving the caller's own `Request` unconsumed. */
function copyOf(input: FetchInput, init?: RequestInit): Request {
  return input instanceof Request && init === undefined
    ? input.clone()
    : new Request(input instanceof Request ? input.clone() : input, init);
}

async function captureRequest(
  request: Request,
  options: FixtureOptions,
): Promise<{ key: string; request: RecordedRequest }> {
  const url = redactUrl(request.url, options.redactQuery);
  const headers = redactHeaders(request.headers, options.redactHeaders);
  const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const contentType = request.headers.get('content-type');
  const encoded = bytes && bytes.length > 0 ? encodeBody(bytes, contentType) : undefined;
  // A multipart upload gets a random boundary on every run; matching on it would make every
  // recording of a file upload unreplayable.
  const boundary = /multipart\/form-data;\s*boundary="?([^";]+)"?/i.exec(contentType ?? '')?.[1];
  const matchBody =
    bytes && boundary ? Buffer.from(bytes).toString('latin1').split(boundary).join('BOUNDARY') : encoded?.body;
  const match = options.match ?? ((input: MatchInput) => defaultKey(input, options.ignoreBodyFields));
  const key = match({ method: request.method, url, headers, ...(matchBody === undefined ? {} : { body: matchBody }) });

  return {
    key,
    request: {
      method: request.method,
      url,
      headers,
      ...(encoded ? { body: encoded.body, bodyEncoding: encoded.bodyEncoding } : {}),
    },
  };
}

function defaultKey(input: MatchInput, ignoreBodyFields: readonly string[] = []): string {
  let body = input.body ?? '';
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const field of ignoreBodyFields) delete (parsed as Record<string, unknown>)[field];
    }
    body = canonical(parsed);
  } catch {
    // Not JSON: matched byte for byte.
  }
  return createHash('sha256').update(`${input.method}\n${input.url}\n${body}`).digest('hex').slice(0, 16);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function redactHeaders(headers: Headers, extra: readonly string[] = []): Record<string, string> {
  const also = new Set(extra.map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name] = CREDENTIAL_HEADER.test(name) || also.has(name) ? REDACTED : value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * `fetch` has already decompressed and reassembled the body by the time it is recorded, so the
 * headers describing the wire encoding would be false on replay.
 */
function withoutTransportHeaders(headers: Record<string, string>): Record<string, string> {
  const { 'content-encoding': _encoding, 'content-length': _length, 'transfer-encoding': _transfer, ...rest } = headers;
  return rest;
}

function redactUrl(raw: string, extra: readonly string[] = []): string {
  const url = new URL(raw);
  const also = new Set(extra.map((name) => name.toLowerCase()));
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !CREDENTIAL_QUERY.has(name.toLowerCase()) && !also.has(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(kept).toString();
  return url.toString();
}

function encodeBody(bytes: Uint8Array, contentType: string | null): { body: string; bodyEncoding: 'utf8' | 'base64' } {
  const textual = !contentType || /^text\/|json|xml|event-stream|x-www-form-urlencoded|javascript/i.test(contentType);
  if (textual) {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Only text that round-trips exactly is stored as text; anything else keeps its bytes.
    if (Buffer.from(decoded, 'utf8').equals(Buffer.from(bytes))) return { body: decoded, bodyEncoding: 'utf8' };
  }
  return { body: Buffer.from(bytes).toString('base64'), bodyEncoding: 'base64' };
}

function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

async function writeExchange(directory: string, exchange: RecordedExchange): Promise<void> {
  await mkdir(directory, { recursive: true });
  const host = new URL(exchange.request.url).host.replace(/[^a-z0-9.-]/gi, '_');
  const file = `${host}-${exchange.request.method.toLowerCase()}-${exchange.key}-${exchange.index}.json`;
  await writeFile(path.join(directory, file), `${JSON.stringify(exchange, null, 2)}\n`, 'utf8');
}

async function loadExchanges(directory: string): Promise<Map<string, RecordedExchange[]>> {
  const byKey = new Map<string, RecordedExchange[]>();
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return byKey;
  }
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const exchange = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as RecordedExchange;
    if (!exchange?.key || !exchange.response) continue;
    byKey.set(exchange.key, [...(byKey.get(exchange.key) ?? []), exchange]);
  }
  for (const exchanges of byKey.values()) exchanges.sort((a, b) => a.index - b.index);
  return byKey;
}
