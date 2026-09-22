import { signOperationWebhook, verifyOperationWebhook } from '../operations/webhooks.js';
import type { PromptHistoryEntry } from '../types/prompts.js';
import type { PromptWebhookConfig } from './registry.js';

/**
 * Verifies a prompt webhook delivery against its `x-nexus-signature` header.
 *
 * Prompt and operation webhooks are signed the same way, so one receiver can verify both.
 */
export const verifyPromptWebhook: typeof verifyOperationWebhook = verifyOperationWebhook;

/** Posts one prompt change to a webhook. Throws on a failed delivery; the registry reports it and moves on. */
export async function deliverPromptWebhook(
  config: PromptWebhookConfig,
  entry: PromptHistoryEntry,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const body = JSON.stringify({ type: `prompt.${entry.action}`, ...entry });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
  try {
    const response = await (config.fetch ?? fetch)(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nexus-signature': signOperationWebhook(body, config.secret, nowSeconds),
        ...config.headers,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Prompt webhook to ${config.url} failed: ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}
