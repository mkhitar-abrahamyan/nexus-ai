export type RealtimeErrorCategory =
  | 'authentication'
  | 'permission'
  | 'configuration'
  | 'capability'
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'provider'
  | 'protocol'
  | 'tool'
  | 'confirmation'
  | 'abort'
  | 'unknown';

export interface RealtimeErrorOptions {
  message: string;
  code?: string;
  category?: RealtimeErrorCategory;
  provider?: string;
  retryable?: boolean;
  fatal?: boolean;
  status?: number;
  eventId?: string;
  cause?: unknown;
  raw?: unknown;
}

export class RealtimeError extends Error {
  readonly code?: string;
  readonly category: RealtimeErrorCategory;
  readonly provider?: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly status?: number;
  readonly eventId?: string;
  readonly raw?: unknown;

  constructor(options: RealtimeErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RealtimeError';
    this.code = options.code;
    this.category = options.category || 'unknown';
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    this.status = options.status;
    this.eventId = options.eventId;
    this.raw = options.raw;
  }
}

export function toRealtimeError(error: unknown, defaults: Partial<RealtimeErrorOptions> = {}): RealtimeError {
  if (error instanceof RealtimeError) {
    if (defaults.fatal === undefined || defaults.fatal === error.fatal) return error;
    return new RealtimeError({
      message: error.message,
      code: error.code,
      category: error.category,
      provider: error.provider,
      retryable: error.retryable,
      fatal: defaults.fatal,
      status: error.status,
      eventId: error.eventId,
      cause: error,
      raw: error.raw,
    });
  }
  const record = isRecord(error) ? error : undefined;
  const message =
    (record && typeof record.message === 'string' && record.message) ||
    (error instanceof Error ? error.message : String(error));
  const name = record && typeof record.name === 'string' ? record.name : undefined;
  const category = defaults.category || inferCategory(name, message);

  return new RealtimeError({
    message: defaults.message || message,
    code: defaults.code || (record && typeof record.code === 'string' ? record.code : undefined),
    category,
    provider: defaults.provider,
    retryable: defaults.retryable ?? ['network', 'timeout', 'rate-limit'].includes(category),
    fatal: defaults.fatal,
    status: defaults.status || (record && typeof record.status === 'number' ? record.status : undefined),
    eventId: defaults.eventId,
    cause: defaults.cause ?? error,
    raw: defaults.raw,
  });
}

function inferCategory(name: string | undefined, message: string): RealtimeErrorCategory {
  const value = `${name || ''} ${message}`.toLowerCase();
  if (value.includes('abort')) return 'abort';
  if (value.includes('timeout') || value.includes('timed out')) return 'timeout';
  if (value.includes('notallowed') || value.includes('permission') || value.includes('denied')) return 'permission';
  if (value.includes('auth') || value.includes('unauthorized') || value.includes('api key')) return 'authentication';
  if (value.includes('network') || value.includes('socket') || value.includes('ice')) return 'network';
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
