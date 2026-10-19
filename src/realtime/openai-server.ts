import type { CredentialResolver } from '../types/lifecycle.js';
import { scrubSecrets } from '../utils/scrub.js';
import { RealtimeError } from './errors.js';
import { decodeBase64, encodeBase64 } from './transport-utils.js';

/** The part of a `fetch` response the server helpers read. */
export interface OpenAIRealtimeServerFetchResponse {
  /** True for a 2xx status. */
  readonly ok: boolean;
  /** HTTP status code. */
  readonly status: number;
  /** HTTP status text. */
  readonly statusText?: string;
  /** Reads the body as text. */
  text(): Promise<string>;
  /** Reads the body as JSON. */
  json?(): Promise<unknown>;
}

/** The part of `fetch` the server helpers use. */
export type OpenAIRealtimeServerFetch = (
  input: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  },
) => Promise<OpenAIRealtimeServerFetchResponse>;

/** The part of `FormData` the SDP exchange needs. */
export interface FormDataLike {
  /** Sets a field. */
  set(name: string, value: string): void;
}

/** Server-side options for creating OpenAI realtime sessions, where the API key lives. */
export interface OpenAIRealtimeServerOptions {
  /** OpenAI API key. Never send it to a browser. Optional when `credentials` resolves one for the tenant. */
  apiKey?: string;
  /**
   * Resolves the key per tenant, as the client's `lifecycle.credentials` does, such as
   * `tenantCredentials()`: the tenant's key replaces `apiKey` in the session or the secret minted for
   * it, so a browser's token is minted with its tenant's key. A resolver that throws refuses it.
   */
  credentials?: CredentialResolver;
  /** The tenant the session or the secret is for, whose key `credentials` resolves. */
  tenantId?: string;
  /** The provider's name, as `credentials` reads it. Defaults to `openai`. */
  provider?: string;
  /** Realtime model. */
  model: string;
  /** Session settings sent to OpenAI, such as instructions or voice. */
  session?: Record<string, unknown>;
  /** API base URL. Defaults to `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Identifies the end user to OpenAI's safety systems, sent as `OpenAI-Safety-Identifier`. */
  safetyIdentifier?: string;
  /** Replaces the global `fetch`. */
  fetch?: OpenAIRealtimeServerFetch;
  /** Creates the multipart form, for runtimes without a global `FormData`. */
  formDataFactory?: () => FormDataLike;
}

/** A short-lived client secret a browser can connect with. */
export interface OpenAIRealtimeClientSecret {
  /** The token. */
  value: string;
  /** Epoch seconds when it expires. */
  expiresAt?: number;
  /** OpenAI's response, unmodified. */
  raw: Record<string, unknown>;
}

/**
 * Exchanges a browser's SDP offer with OpenAI and returns the SDP answer. What your
 * `sessionEndpoint` does in `unified-sdp` mode.
 */
export async function createOpenAIRealtimeCall(
  sdp: string,
  options: OpenAIRealtimeServerOptions,
  signal?: AbortSignal,
): Promise<string> {
  if (!sdp.trim()) throw configurationError('An SDP offer is required');
  return withKey(options, 'realtime.call', async (headers) => {
    const form = resolveFormData(options);
    form.set('sdp', sdp);
    form.set('session', JSON.stringify(sessionConfig(options)));
    const response = await request(
      `${baseUrl(options)}/realtime/calls`,
      { method: 'POST', headers, body: form, signal },
      options,
    );
    return response.text();
  });
}

/**
 * Mints an ephemeral client secret for a browser session. What your `sessionEndpoint` does in
 * `ephemeral-token` mode.
 */
export async function createOpenAIRealtimeClientSecret(
  options: OpenAIRealtimeServerOptions,
  signal?: AbortSignal,
): Promise<OpenAIRealtimeClientSecret> {
  const response = await withKey(options, 'realtime.client_secret', (headers) =>
    request(
      `${baseUrl(options)}/realtime/client_secrets`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionConfig(options) }),
        signal,
      },
      options,
    ),
  );
  const rawText = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new RealtimeError({
      message: 'OpenAI returned an invalid client-secret response',
      code: 'invalid_client_secret_response',
      category: 'protocol',
      provider: 'openai',
      cause: error,
    });
  }
  if (!isRecord(raw) || typeof raw.value !== 'string' || !raw.value) {
    throw new RealtimeError({
      message: 'OpenAI client-secret response did not include a value',
      code: 'missing_client_secret',
      category: 'protocol',
      provider: 'openai',
    });
  }
  return {
    value: raw.value,
    expiresAt:
      typeof raw.expires_at === 'number'
        ? raw.expires_at
        : isRecord(raw.expires_at) && typeof raw.expires_at.epoch_seconds === 'number'
          ? raw.expires_at.epoch_seconds
          : undefined,
    raw,
  };
}

/** What controlling a call OpenAI carries needs: the key, and how to reach OpenAI. */
export type OpenAIRealtimeCallOptions = Pick<
  OpenAIRealtimeServerOptions,
  'apiKey' | 'baseUrl' | 'safetyIdentifier' | 'fetch'
>;

/**
 * Answers a call OpenAI is carrying, such as an incoming SIP call, with the session that will run
 * it: its model, instructions, tools, and audio, as `createOpenAISessionUpdate()` builds them.
 */
export async function acceptOpenAIRealtimeCall(
  callId: string,
  session: Record<string, unknown>,
  options: OpenAIRealtimeCallOptions,
  signal?: AbortSignal,
): Promise<void> {
  await callRequest(callId, 'accept', { type: 'realtime', ...session }, options, signal);
}

/** Declines a call, with a SIP status: 603 (decline) by default, or 486 (busy), say. */
export async function rejectOpenAIRealtimeCall(
  callId: string,
  options: OpenAIRealtimeCallOptions & { statusCode?: number },
  signal?: AbortSignal,
): Promise<void> {
  await callRequest(callId, 'reject', { status_code: options.statusCode ?? 603 }, options, signal);
}

/** Transfers an accepted call to another number or SIP address, such as `tel:+14155550123`. */
export async function referOpenAIRealtimeCall(
  callId: string,
  targetUri: string,
  options: OpenAIRealtimeCallOptions,
  signal?: AbortSignal,
): Promise<void> {
  if (!targetUri.trim()) throw configurationError('A transfer needs a target URI');
  await callRequest(callId, 'refer', { target_uri: targetUri }, options, signal);
}

/** Ends a call. */
export async function hangupOpenAIRealtimeCall(
  callId: string,
  options: OpenAIRealtimeCallOptions,
  signal?: AbortSignal,
): Promise<void> {
  await callRequest(callId, 'hangup', undefined, options, signal);
}

/** Headers as a `Headers` object or a plain record, such as Node's `request.headers`. */
export type OpenAIWebhookHeaders =
  | { get(name: string): string | null }
  | Record<string, string | readonly string[] | undefined>;

/** One event OpenAI delivered to your webhook. */
export interface OpenAIWebhookEvent {
  /** The event's id. */
  id: string;
  /** What happened, such as `realtime.call.incoming`. */
  type: string;
  /** Epoch seconds when it happened. */
  created_at?: number;
  /** The event's data. */
  data: Record<string, unknown>;
  /** The webhook delivery's id, the same on every retry of it. */
  webhookId: string;
}

/** How `verifyOpenAIWebhook()` checks a delivery. */
export interface OpenAIWebhookVerifyOptions {
  /** How old a delivery may be, in seconds, before it is refused as a replay. Defaults to 300. */
  toleranceSeconds?: number;
  /** Replaces the system clock, in milliseconds, for tests. */
  now?: () => number;
}

/**
 * Checks a webhook delivery's signature against your endpoint's signing secret (`whsec_...`) and
 * returns its event. A delivery that is unsigned, signed with another secret, altered, or older than
 * the tolerance is refused with a `RealtimeError` of code `invalid_webhook_signature`. Pass the body
 * exactly as it arrived: reformatted JSON no longer matches its signature.
 */
export async function verifyOpenAIWebhook(
  request: { headers: OpenAIWebhookHeaders; body: string | Uint8Array },
  secret: string,
  options: OpenAIWebhookVerifyOptions = {},
): Promise<OpenAIWebhookEvent> {
  const id = header(request.headers, 'webhook-id');
  const timestamp = header(request.headers, 'webhook-timestamp');
  const signatures = header(request.headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) throw signatureError('The delivery is not signed');
  const seconds = Number(timestamp);
  const now = (options.now?.() ?? Date.now()) / 1_000;
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > (options.toleranceSeconds ?? 300)) {
    throw signatureError('The delivery is too old or from the future');
  }
  const body = typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body);
  const subtle = (globalThis as { crypto?: { subtle?: HmacSubtle } }).crypto?.subtle;
  if (!subtle) throw configurationError('This environment does not provide Web Crypto');
  const key = await subtle.importKey(
    'raw',
    decodeBase64(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = encodeBase64(signed);
  const matches = signatures
    .split(' ')
    .map((entry) => entry.split(','))
    .some(([version, signature]) => version === 'v1' && signature !== undefined && sameText(signature, expected));
  if (!matches) throw signatureError('The delivery is not signed with this secret');
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch (error) {
    throw new RealtimeError({
      message: 'The webhook delivery is not JSON',
      code: 'invalid_webhook_event',
      category: 'protocol',
      provider: 'openai',
      cause: error,
    });
  }
  if (!isRecord(event) || typeof event.type !== 'string') {
    throw new RealtimeError({
      message: 'The webhook delivery is not an event',
      code: 'invalid_webhook_event',
      category: 'protocol',
      provider: 'openai',
    });
  }
  return {
    ...event,
    id: typeof event.id === 'string' ? event.id : id,
    type: event.type,
    data: isRecord(event.data) ? event.data : {},
    webhookId: id,
  } as OpenAIWebhookEvent;
}

/**
 * Returns a function that exchanges an SDP offer, ready to put behind your own HTTP route. Give each
 * call its `tenantId`, such as the one your route authenticated, and with `credentials` the session
 * is made with that tenant's key.
 */
export function createOpenAIRealtimeSessionEndpoint(options: OpenAIRealtimeServerOptions) {
  return (sdp: string, signal?: AbortSignal, call: { tenantId?: string } = {}) =>
    createOpenAIRealtimeCall(
      sdp,
      call.tenantId !== undefined ? { ...options, tenantId: call.tenantId } : options,
      signal,
    );
}

async function request(
  input: string,
  init: Parameters<OpenAIRealtimeServerFetch>[1],
  options: OpenAIRealtimeCallOptions,
): Promise<OpenAIRealtimeServerFetchResponse> {
  let response: OpenAIRealtimeServerFetchResponse;
  try {
    response = await resolveFetch(options)(input, init);
  } catch (error) {
    throw new RealtimeError({
      message: error instanceof Error ? redact(error.message) : 'OpenAI Realtime request failed',
      code: 'openai_realtime_network_error',
      category: init.signal?.aborted ? 'abort' : 'network',
      provider: 'openai',
      retryable: !init.signal?.aborted,
    });
  }
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  throw new RealtimeError({
    message: `OpenAI Realtime request failed with HTTP ${response.status}${body ? `: ${redact(body)}` : ''}`,
    code: 'openai_realtime_http_error',
    category:
      response.status === 401 || response.status === 403
        ? 'authentication'
        : response.status === 429
          ? 'rate-limit'
          : 'provider',
    provider: 'openai',
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}

async function callRequest(
  callId: string,
  action: 'accept' | 'reject' | 'refer' | 'hangup',
  body: Record<string, unknown> | undefined,
  options: OpenAIRealtimeCallOptions,
  signal?: AbortSignal,
): Promise<void> {
  if (!callId.trim()) throw configurationError('A call id is required');
  // A call OpenAI carries belongs to the project that received it: it is controlled with that project's key.
  const response = await request(
    `${baseUrl(options)}/realtime/calls/${encodeURIComponent(callId)}/${action}`,
    {
      method: 'POST',
      headers: {
        ...authorizationHeaders(options.apiKey, options),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    },
    options,
  );
  await response.text().catch(() => '');
}

function header(headers: OpenAIWebhookHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | readonly string[] | undefined>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

/** The part of Web Crypto's `crypto.subtle` that signs with HMAC. */
interface HmacSubtle {
  importKey(
    format: 'raw',
    key: ArrayBuffer,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: boolean,
    usages: ['sign'],
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Compares two strings in time that does not depend on where they differ. */
function sameText(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function signatureError(message: string): RealtimeError {
  return new RealtimeError({
    message,
    code: 'invalid_webhook_signature',
    category: 'authentication',
    provider: 'openai',
  });
}

function sessionConfig(options: OpenAIRealtimeServerOptions): Record<string, unknown> {
  return {
    type: 'realtime',
    model: options.model,
    ...options.session,
  };
}

function authorizationHeaders(apiKey: string | undefined, options: OpenAIRealtimeCallOptions): Record<string, string> {
  if (!apiKey?.trim()) throw configurationError('A server-side OpenAI API key is required');
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(options.safetyIdentifier ? { 'OpenAI-Safety-Identifier': options.safetyIdentifier } : {}),
  };
}

/**
 * Runs a request with the key it is made with: the tenant's, when `credentials` resolves one, or the
 * configured one. Its errors are cleaned of whatever the resolver returned.
 */
async function withKey<T>(
  options: OpenAIRealtimeServerOptions,
  operation: string,
  run: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const credential = options.credentials
    ? await options.credentials.resolve({
        provider: options.provider ?? 'openai',
        ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        family: 'realtime',
        operation,
      })
    : undefined;
  const secrets = [credential?.apiKey, ...Object.values(credential?.headers ?? {})].filter(
    (value): value is string => typeof value === 'string',
  );
  try {
    return await run({
      ...authorizationHeaders(credential?.apiKey ?? options.apiKey, options),
      ...credential?.headers,
    });
  } catch (error) {
    throw scrubSecrets(error, secrets);
  }
}

function baseUrl(options: OpenAIRealtimeCallOptions): string {
  return (options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
}

function resolveFetch(options: OpenAIRealtimeCallOptions): OpenAIRealtimeServerFetch {
  if (options.fetch) return options.fetch;
  const runtime = globalThis as unknown as { fetch?: OpenAIRealtimeServerFetch };
  if (!runtime.fetch) throw configurationError('This environment does not provide fetch');
  return runtime.fetch.bind(globalThis);
}

function resolveFormData(options: OpenAIRealtimeServerOptions): FormDataLike {
  if (options.formDataFactory) return options.formDataFactory();
  const runtime = globalThis as unknown as { FormData?: new () => FormDataLike };
  if (!runtime.FormData) throw configurationError('This environment does not provide FormData');
  return new runtime.FormData();
}

function configurationError(message: string): RealtimeError {
  return new RealtimeError({
    message,
    code: 'openai_realtime_configuration_error',
    category: 'configuration',
    provider: 'openai',
  });
}

function redact(value: string): string {
  return value
    .replace(/(?:sk|sess)-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/"(api[_-]?key|authorization|token|secret)"\s*:\s*"[^"]+"/gi, '"$1":"[REDACTED]"')
    .slice(0, 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
