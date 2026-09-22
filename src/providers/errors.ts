/** Why a provider call failed, in terms that decide whether to retry or fall back. */
export type NexusProviderErrorCategory =
  | 'auth'
  | 'abort'
  | 'timeout'
  | 'rate-limit'
  | 'server-error'
  | 'network'
  | 'bad-response'
  | 'unknown';

/** Options for constructing a `NexusProviderError`. */
export interface NexusProviderErrorOptions {
  /** The provider that failed. */
  provider: string;
  /** The model requested. */
  model: string;
  /** What went wrong. */
  message: string;
  /** HTTP status, when the provider answered. */
  status?: number;
  /** Why it failed. Inferred from the cause and status when omitted. */
  category?: NexusProviderErrorCategory;
  /** Whether retrying could succeed. Inferred from the category and status when omitted. */
  retryable?: boolean;
  /** The underlying error. */
  cause?: unknown;
}

/**
 * An error from a provider call, carrying enough context to decide whether to retry or fall back.
 */
export class NexusProviderError extends Error {
  /** The provider that failed. */
  readonly provider: string;
  /** The model requested. */
  readonly model: string;
  /** HTTP status, when the provider answered. */
  readonly status?: number;
  /** Why it failed. */
  readonly category: NexusProviderErrorCategory;
  /** Whether retrying could succeed. */
  readonly retryable: boolean;
  /** The underlying error. */
  override readonly cause?: unknown;

  constructor(options: NexusProviderErrorOptions) {
    super(options.message);
    this.name = 'NexusProviderError';
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.category = options.category || categorizeProviderError(options.cause, options.status);
    this.retryable = options.retryable ?? isRetryableProviderError(this.category, options.status);
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Builds an error from a failed HTTP response, including the first 1,000 characters of its body.
 */
export async function createProviderHttpError(
  provider: string,
  model: string,
  response: Response,
): Promise<NexusProviderError> {
  const body = await safeResponseText(response);
  const details = body ? ` ${body}` : '';
  return new NexusProviderError({
    provider,
    model,
    status: response.status,
    message: `${provider} request failed: ${response.status}${details}`,
  });
}

/**
 * Wraps any error as a `NexusProviderError`, inferring the status and category it does not know. A
 * `NexusProviderError` is returned unchanged.
 */
export function toNexusProviderError(
  error: unknown,
  context: Pick<NexusProviderErrorOptions, 'provider' | 'model'> & Partial<NexusProviderErrorOptions>,
): NexusProviderError {
  if (error instanceof NexusProviderError) return error;

  const status = context.status ?? extractStatus(error);
  const category = context.category ?? categorizeProviderError(error, status);
  const message =
    context.message || `${context.provider} request failed: ${error instanceof Error ? error.message : String(error)}`;

  return new NexusProviderError({
    provider: context.provider,
    model: context.model,
    status,
    category,
    retryable: context.retryable,
    message,
    cause: context.cause ?? error,
  });
}

/** An error for a request the caller aborted. Never retryable. */
export function createAbortProviderError(provider: string, model: string, cause?: unknown): NexusProviderError {
  return new NexusProviderError({
    provider,
    model,
    category: 'abort',
    retryable: false,
    message: `${provider} request aborted`,
    cause,
  });
}

/** An error for a request that ran past its timeout. Retryable. */
export function createTimeoutProviderError(provider: string, model: string, timeoutMs: number): NexusProviderError {
  return new NexusProviderError({
    provider,
    model,
    category: 'timeout',
    retryable: true,
    message: `${provider} request timed out after ${timeoutMs}ms`,
  });
}

/** Categorizes an error from its HTTP status, then from its name, code, and message. */
export function categorizeProviderError(error: unknown, status?: number): NexusProviderErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status !== undefined && status >= 500) return 'server-error';
  if (isAbortError(error)) return 'abort';

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code).toLowerCase()
      : '';

  if (message.includes('timed out') || message.includes('timeout') || code === 'etimedout') return 'timeout';
  if (message.includes('429') || message.includes('rate limit')) return 'rate-limit';
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504'))
    return 'server-error';
  if (message.includes('invalid json') || message.includes('unexpected token')) return 'bad-response';
  if (
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    code === 'econnreset' ||
    code === 'enotfound'
  ) {
    return 'network';
  }

  return 'unknown';
}

/**
 * Whether a category of failure is worth retrying: timeouts, rate limits, server errors, and
 * network failures are.
 */
export function isRetryableProviderError(category: NexusProviderErrorCategory, status?: number): boolean {
  if (category === 'abort' || category === 'auth' || category === 'bad-response') return false;
  if (category === 'timeout' || category === 'rate-limit' || category === 'server-error' || category === 'network')
    return true;
  return Boolean(status && status >= 500);
}

/** Whether an error is an abort, by its name, its code, or its message. */
export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError') return true;
  if (typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ABORT_ERR') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('aborted') || message.includes('aborterror');
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value =
    (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return '';
  }
}
