import type { Run, RunQuery, RunTree } from '../types/tracing.js';

/** Filters and orders runs. Shared by every store, so a query means the same thing everywhere. */
export function applyQuery(runs: Run[], query: RunQuery = {}): Run[] {
  const kinds = query.kind === undefined ? undefined : Array.isArray(query.kind) ? query.kind : [query.kind];
  const matched = runs.filter((run) => {
    if (query.traceId && run.traceId !== query.traceId) return false;
    if (kinds && !kinds.includes(run.kind)) return false;
    if (query.status && run.status !== query.status) return false;
    if (query.name && run.name !== query.name) return false;
    if (query.model && run.model !== query.model) return false;
    if (query.provider && run.provider !== query.provider) return false;
    if (query.tags?.length && !query.tags.every((tag) => run.tags?.includes(tag))) return false;
    if (query.minLatencyMs !== undefined && (run.latencyMs ?? 0) < query.minLatencyMs) return false;
    if (query.minCost !== undefined && (run.cost ?? 0) < query.minCost) return false;
    if (query.since && run.startedAt < query.since) return false;
    if (query.until && run.startedAt > query.until) return false;
    if (query.feedbackKey && !run.feedback?.some((item) => item.key === query.feedbackKey)) return false;
    if (query.metadata) {
      for (const [field, expected] of Object.entries(query.metadata)) {
        if (readPath(run.metadata, field) !== expected) return false;
      }
    }
    return true;
  });

  const ordered = matched.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const offset = query.offset ?? 0;
  return ordered.slice(offset, offset + (query.limit ?? 50));
}

/** Assembles runs into a tree under their root, children ordered by start time. */
export function assembleTree(runs: Run[]): RunTree | undefined {
  const nodes = new Map<string, RunTree>(runs.map((run) => [run.id, { ...run, children: [] }]));
  let root: RunTree | undefined;
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else root ??= node;
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return root;
}

export function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}
