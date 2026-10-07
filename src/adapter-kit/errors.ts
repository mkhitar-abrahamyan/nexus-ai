/**
 * One vocabulary for adapter failures, so code above an adapter retries, alerts, and reports the same
 * way whichever database, provider, or service the adapter talks to.
 */

/** What kind of failure an adapter call met. */
export type AdapterErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'CANCELLED'
  | 'UNKNOWN';

/** A failure's code, and whether another attempt could succeed. */
export interface AdapterErrorClass {
  /** The kind of failure. */
  code: AdapterErrorCode;
  /** True for a failure a retry could get past: a rate limit, a timeout, an unavailable service. */
  retryable: boolean;
  /** The HTTP status, when the failure carried one. */
  status?: number;
}

/** A failed adapter call, normalized. The original error is its `cause`. */
export class AdapterError extends Error {
  /** The kind of failure. */
  readonly code: AdapterErrorCode;
  /** Whether another attempt could succeed. */
  readonly retryable: boolean;
  /** The HTTP status, when the failure carried one. */
  readonly status?: number;

  constructor(
    /** The adapter that failed. */
    readonly adapter: string,
    /** The method that failed, such as `search`. */
    readonly operation: string,
    failure: AdapterErrorClass,
    cause: unknown,
  ) {
    super(
      `${adapter} ${operation} failed (${failure.code}): ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.name = 'AdapterError';
    this.code = failure.code;
    this.retryable = failure.retryable;
    if (failure.status !== undefined) this.status = failure.status;
  }
}

const RETRYABLE = new Set<AdapterErrorCode>(['RATE_LIMIT', 'TIMEOUT', 'UNAVAILABLE']);

/**
 * Classifies any error by what it carries: an HTTP status (`status`, `statusCode`, or
 * `response.status`), a Node network code such as `ECONNREFUSED`, or an `AbortError` or
 * `TimeoutError` name. An adapter's own `normalizeError` runs first and may override it.
 */
export function classifyAdapterError(error: unknown): AdapterErrorClass {
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    code?: unknown;
    name?: unknown;
  } | null;
  const raw = value?.status ?? value?.statusCode ?? value?.response?.status;
  const status = typeof raw === 'number' ? raw : undefined;
  const code = ((): AdapterErrorCode => {
    if (value?.name === 'AbortError') return 'CANCELLED';
    if (value?.name === 'TimeoutError' || value?.code === 'ETIMEDOUT') return 'TIMEOUT';
    if (status !== undefined) {
      if (status === 401 || status === 403) return 'AUTH';
      if (status === 404) return 'NOT_FOUND';
      if (status === 408) return 'TIMEOUT';
      if (status === 409 || status === 412) return 'CONFLICT';
      if (status === 429) return 'RATE_LIMIT';
      if (status >= 500) return 'UNAVAILABLE';
      if (status >= 400) return 'INVALID';
    }
    if (typeof value?.code === 'string' && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(value.code)) {
      return 'UNAVAILABLE';
    }
    return 'UNKNOWN';
  })();
  return { code, retryable: RETRYABLE.has(code), ...(status === undefined ? {} : { status }) };
}
