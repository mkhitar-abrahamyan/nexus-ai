import { tool } from '../agent/tool.js';
import type { ToolDefinition } from '../types/messages.js';

export interface WebConnectorOptions {
  allowedDomains?: string[];
  timeoutMs?: number;
  userAgent?: string;
}

export function createFetchUrlTool(options: WebConnectorOptions = {}): ToolDefinition {
  return tool({
    name: 'fetch_url',
    description: 'Fetch text content from an allowed URL.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
      },
    },
    execute: async (args) => {
      const url = String(args.url || '');
      assertAllowedUrl(url, options.allowedDomains);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10_000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'user-agent': options.userAgent || 'nexus-ai-pro/0.1' },
        });
        return {
          url,
          ok: response.ok,
          status: response.status,
          text: (await response.text()).slice(0, 20_000),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

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

function assertAllowedUrl(url: string, allowedDomains?: string[]): void {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  if (!allowedDomains?.length) return;
  const allowed = allowedDomains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
  if (!allowed) throw new Error(`URL domain ${parsed.hostname} is not allowed`);
}
