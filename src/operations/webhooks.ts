import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OperationEvent, OperationWebhookConfig } from '../types/operations.js';

const SIGNATURE_HEADER = 'x-nexus-signature';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Rejects a replayed delivery older than this by default. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Builds the signature for one delivery.
 *
 * The signed value is `${timestamp}.${body}` rather than the body alone, so a captured delivery
 * cannot be replayed indefinitely: a receiver checks the timestamp is recent and the signature
 * covers it, and an attacker cannot move the timestamp without invalidating the digest.
 */
export function signOperationWebhook(body: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

export interface VerifyOperationWebhookOptions {
  /** Maximum delivery age in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  /** Current time in seconds, for tests. */
  nowSeconds?: number;
}

/**
 * Verifies a delivery signature.
 *
 * Exported because a receiver needs it: shipping the signing half without the verifying half
 * pushes every consumer into writing their own HMAC comparison, which is exactly the code most
 * likely to be written without a constant-time compare.
 */
export function verifyOperationWebhook(
  body: string,
  header: string | undefined,
  secret: string,
  options: VerifyOperationWebhookOptions = {},
): boolean {
  if (!header) return false;

  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index > 0) parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
  }

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');
  if (!provided || !Number.isFinite(timestamp)) return false;

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

/** Terminal events, which is what a receiver almost always wants. */
const DEFAULT_EVENTS: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

/**
 * Delivers one operation event to a configured endpoint.
 *
 * Throws on a failed delivery so the caller can decide what to do. The runner reports the error
 * through `onWebhookError` and continues: a webhook that a receiver cannot accept must not turn a
 * successful operation into a failed one.
 */
export async function deliverOperationWebhook(
  config: OperationWebhookConfig,
  event: OperationEvent<unknown>,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const selected = config.events ? new Set<string>(config.events) : DEFAULT_EVENTS;
  if (!selected.has(event.type)) return;

  const body = JSON.stringify(event);
  const fetchImpl = config.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signOperationWebhook(body, config.secret, nowSeconds),
        ...config.headers,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Operation webhook to ${config.url} failed: ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export { SIGNATURE_HEADER as OPERATION_WEBHOOK_SIGNATURE_HEADER };
