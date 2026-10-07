/** A JavaScript runtime this package recognizes. */
export type RuntimeName = 'node' | 'deno' | 'bun' | 'workerd' | 'edge-light' | 'browser' | 'unknown';

/** Which runtime the code is running on. */
export interface RuntimeInfo {
  /**
   * `node`, `deno`, `bun`, `workerd` for Cloudflare Workers, `edge-light` for Vercel's edge
   * runtime, `browser` for a page or a web worker, or `unknown`.
   */
  name: RuntimeName;
  /** The runtime's version, where it reports one. */
  version?: string;
}

/**
 * Which runtime the code is running on, from what each one reliably exposes. Deno and Bun are
 * checked before Node.js, since both also present Node's `process`.
 */
export function runtimeInfo(): RuntimeInfo {
  const host = globalThis as {
    Deno?: { version?: { deno?: string } };
    Bun?: { version?: string };
    EdgeRuntime?: unknown;
    navigator?: { userAgent?: string };
    process?: { versions?: { node?: string } };
    document?: unknown;
    importScripts?: unknown;
  };
  if (host.Deno?.version?.deno) return { name: 'deno', version: host.Deno.version.deno };
  if (host.Bun?.version) return { name: 'bun', version: host.Bun.version };
  if (typeof host.EdgeRuntime === 'string') return { name: 'edge-light' };
  if (host.navigator?.userAgent === 'Cloudflare-Workers') return { name: 'workerd' };
  if (host.process?.versions?.node) return { name: 'node', version: host.process.versions.node };
  if (host.document !== undefined || typeof host.importScripts === 'function') return { name: 'browser' };
  return { name: 'unknown' };
}
