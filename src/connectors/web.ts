import { tool } from '../agent/tool.js';
import type { ToolDefinition } from '../types/messages.js';
import {
  nonNegativeInteger,
  parseUrl,
  positiveInteger,
  safeFetch,
  type SafeFetchPolicy,
  type WebResolvedAddress,
} from '../utils/safe-fetch.js';

export type { WebResolvedAddress };

/** Options for the fetch-URL tool, including its SSRF policy. */
export interface WebConnectorOptions extends SafeFetchPolicy {
  /** Gives up after this long, in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Largest response read, in bytes. Longer responses are truncated. Defaults to 20,000. */
  maxResponseBytes?: number;
  /** Redirects followed, each checked against the policy again. Defaults to 5. */
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * A `fetch_url` tool that reads text from public URLs allowed by the policy, refusing private
 * addresses.
 */
export function createFetchUrlTool(options: WebConnectorOptions = {}): ToolDefinition {
  return tool({
    name: 'fetch_url',
    description: 'Fetch text content from an allowed public URL.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
      },
    },
    execute: async (args) => {
      const initialUrl = parseUrl(String(args.url || ''));
      const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
      const maxResponseBytes = positiveInteger(
        options.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
        'maxResponseBytes',
      );
      const maxRedirects = nonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 'maxRedirects');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();

      try {
        return await fetchText(initialUrl, options, controller.signal, maxResponseBytes, maxRedirects);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`URL fetch timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

/** A search tool around your own search function. */
export function createSearchTool(search: (query: string) => Promise<unknown>, name = 'web_search'): ToolDefinition {
  return tool({
    name,
    description: 'Search the web or an external search index.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
      },
    },
    execute: async (args) => search(String(args.query || '')),
  });
}

async function fetchText(
  initialUrl: URL,
  options: WebConnectorOptions,
  signal: AbortSignal,
  maxResponseBytes: number,
  maxRedirects: number,
): Promise<{ url: string; ok: boolean; status: number; text: string; truncated: boolean }> {
  const response = await safeFetch(initialUrl, {
    ...options,
    maxBytes: maxResponseBytes,
    maxRedirects,
    signal,
    accept: 'text/*, application/json;q=0.9, */*;q=0.1',
  });
  return {
    url: response.url,
    ok: response.ok,
    status: response.status,
    text: response.bytes.toString('utf8'),
    truncated: response.truncated,
  };
}
