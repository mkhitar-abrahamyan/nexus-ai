import { RealtimeError } from './errors.js';

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
  /** OpenAI API key. Never send it to a browser. */
  apiKey: string;
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
  const form = resolveFormData(options);
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(sessionConfig(options)));
  const response = await request(
    `${baseUrl(options)}/realtime/calls`,
    {
      method: 'POST',
      headers: authorizationHeaders(options),
      body: form,
      signal,
    },
    options,
  );
  return response.text();
}

/**
 * Mints an ephemeral client secret for a browser session. What your `sessionEndpoint` does in
 * `ephemeral-token` mode.
 */
export async function createOpenAIRealtimeClientSecret(
  options: OpenAIRealtimeServerOptions,
  signal?: AbortSignal,
): Promise<OpenAIRealtimeClientSecret> {
  const response = await request(
    `${baseUrl(options)}/realtime/client_secrets`,
    {
      method: 'POST',
      headers: { ...authorizationHeaders(options), 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionConfig(options) }),
      signal,
    },
    options,
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

/** Returns a function that exchanges an SDP offer, ready to put behind your own HTTP route. */
export function createOpenAIRealtimeSessionEndpoint(options: OpenAIRealtimeServerOptions) {
  return (sdp: string, signal?: AbortSignal) => createOpenAIRealtimeCall(sdp, options, signal);
}

async function request(
  input: string,
  init: Parameters<OpenAIRealtimeServerFetch>[1],
  options: OpenAIRealtimeServerOptions,
): Promise<OpenAIRealtimeServerFetchResponse> {
  if (!options.apiKey.trim()) throw configurationError('A server-side OpenAI API key is required');
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

function sessionConfig(options: OpenAIRealtimeServerOptions): Record<string, unknown> {
  return {
    type: 'realtime',
    model: options.model,
    ...options.session,
  };
}

function authorizationHeaders(options: OpenAIRealtimeServerOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${options.apiKey}`,
    ...(options.safetyIdentifier ? { 'OpenAI-Safety-Identifier': options.safetyIdentifier } : {}),
  };
}

function baseUrl(options: OpenAIRealtimeServerOptions): string {
  return (options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
}

function resolveFetch(options: OpenAIRealtimeServerOptions): OpenAIRealtimeServerFetch {
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
