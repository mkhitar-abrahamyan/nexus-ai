import { cosineSimilarity, type EmbeddingProvider, normalizeVector } from '../hallucination/retrieval.js';
import type { Run, RunQuery, RunTree, TraceStore } from '../types/tracing.js';

/** How runs are grouped: by what went wrong, by the path they took, or by what their text means. */
export type ClusterBy = 'error' | 'trajectory' | 'meaning';

/** Options for `clusterRuns()`. */
export interface ClusterOptions {
  /** What runs are grouped by. Defaults to `error`. */
  by?: ClusterBy;
  /**
   * A run's path, for `trajectory`: the steps it took, in order. Defaults to `trajectoryOf()` for a
   * run tree, or a `trajectory` list in the run's metadata.
   */
  trajectory?: (run: Run) => readonly string[] | undefined;
  /** A run's text, for `meaning`. Defaults to its error message, or else its outputs as JSON. */
  text?: (run: Run) => string;
  /** Embeds texts, for `meaning`. Use the embedding function retrieval uses. */
  embed?: EmbeddingProvider;
  /** How similar two texts must be to share a cluster, for `meaning`. Defaults to 0.85. */
  threshold?: number;
  /** Clusters smaller than this are left out. Defaults to 1. */
  minSize?: number;
}

/** Runs that failed, or behaved, the same way. */
export interface RunCluster {
  /** Stable id: the grouping and a hash of the signature, so the same problem keeps its id across runs. */
  id: string;
  /** What the runs were grouped by. */
  by: ClusterBy;
  /**
   * What the runs share: the run name and normalized error message, the path as `a > b > c`, or the
   * first run's text for a meaning cluster.
   */
  signature: string;
  /** The runs, as given. */
  runs: Run[];
  /** How many runs. */
  count: number;
  /** Distinct run names among them. */
  names: string[];
  /** Distinct models among them. */
  models: string[];
  /** ISO-8601 start of the earliest run. */
  firstSeen: string;
  /** ISO-8601 start of the latest run. */
  lastSeen: string;
}

/**
 * An error message with what varies between occurrences taken out — ids, numbers, quoted values,
 * addresses — so the same failure reads the same every time it happens.
 */
export function errorSignature(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\bhttps?:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(["'`])(?:(?!\1)[^\n]){0,200}\1/g, '<value>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The steps a run tree took, depth first in start order: each descendant as `kind:name`. */
export function trajectoryOf(tree: RunTree): string[] {
  const steps: string[] = [];
  const walk = (node: RunTree) => {
    for (const child of [...node.children].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      steps.push(`${child.kind}:${child.name}`);
      walk(child);
    }
  };
  walk(tree);
  return steps;
}

/**
 * Groups runs that failed or behaved the same way. `error` groups by run name and normalized error
 * message; `trajectory` by the path taken; `meaning` by embedding each run's text and joining it to
 * the first cluster whose leader is at least `threshold` similar. Clusters come back largest first.
 */
export async function clusterRuns(runs: readonly Run[], options: ClusterOptions = {}): Promise<RunCluster[]> {
  const by = options.by ?? 'error';
  const groups = new Map<string, Run[]>();

  if (by === 'meaning') {
    if (!options.embed) throw new RangeError('Clustering by meaning needs an embed function');
    const text = options.text ?? defaultText;
    const texts = runs.map((run) => text(run).slice(0, 4000));
    const vectors = (await options.embed(texts)).map((vector) => normalizeVector([...vector]));
    const threshold = options.threshold ?? 0.85;
    const leaders: Array<{ vector: number[]; signature: string }> = [];
    for (const [index, run] of runs.entries()) {
      const vector = vectors[index] as number[];
      const leader = leaders.find((candidate) => cosineSimilarity(candidate.vector, vector) >= threshold);
      const signature = leader?.signature ?? (texts[index] as string).slice(0, 300);
      if (!leader) leaders.push({ vector, signature });
      groups.set(signature, [...(groups.get(signature) ?? []), run]);
    }
  } else {
    for (const run of runs) {
      let signature: string;
      if (by === 'trajectory') {
        const steps = options.trajectory?.(run) ?? defaultTrajectory(run);
        signature = `${run.name}: ${(steps ?? []).join(' > ') || '(no steps)'}`;
      } else {
        signature = `${run.name}: ${run.error ? `${run.error.name}: ${errorSignature(run.error.message)}` : '(no error)'}`;
      }
      groups.set(signature, [...(groups.get(signature) ?? []), run]);
    }
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length >= (options.minSize ?? 1))
    .map(([signature, members]) => {
      const started = members.map((run) => run.startedAt).sort();
      return {
        id: `${by}-${hash(signature)}`,
        by,
        signature,
        runs: members,
        count: members.length,
        names: [...new Set(members.map((run) => run.name))],
        models: [...new Set(members.map((run) => run.model).filter((model): model is string => Boolean(model)))],
        firstSeen: started[0] as string,
        lastSeen: started[started.length - 1] as string,
      };
    })
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

/** Options for `findIssues()`. */
export interface FindIssuesOptions extends Omit<ClusterOptions, 'minSize'> {
  /** Where the runs are. */
  store: TraceStore;
  /** ISO-8601 start of the window. Defaults to the last 24 hours. */
  since?: string;
  /** ISO-8601 end of the window. */
  until?: string;
  /** Narrows the runs read, such as `{ name: 'support-agent' }`. */
  query?: RunQuery;
  /** Runs at least this slow, in milliseconds, are reported as slow issues. Slowness is not checked without it. */
  slowMs?: number;
  /** Only root runs — one per request — which is what an issue counts. On by default. */
  roots?: boolean;
  /** Runs read from the store. Defaults to 1,000. */
  limit?: number;
  /** Clusters smaller than this are not issues. Defaults to 2. */
  minCount?: number;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** A problem found in recent runs: a cluster of failing or slow runs, and how common it is. */
export interface Issue {
  /** Stable id: the kind and the cluster's id. */
  id: string;
  /** Whether the runs failed or were slow. */
  kind: 'failing' | 'slow';
  /** The runs and what they share. */
  cluster: RunCluster;
  /** The share of the window's runs this issue covers, from 0 to 1. */
  rate: number;
  /** One readable line, such as `12 failing runs of support-agent: TypeError: …`. */
  summary: string;
}

/**
 * Finds the problems in a window of traces: failing runs, and slow runs when `slowMs` is set, each
 * clustered the way `by` asks, most common first. Trajectory clustering reads each run's trace tree.
 */
export async function findIssues(options: FindIssuesOptions): Promise<Issue[]> {
  const now = options.now ?? (() => new Date());
  const since = options.since ?? new Date(now().getTime() - 86_400_000).toISOString();
  const all = await options.store.query({
    ...options.query,
    since,
    ...(options.until ? { until: options.until } : {}),
    limit: options.limit ?? 1000,
  });
  const runs = (options.roots ?? true) ? all.filter((run) => !run.parentId) : all;
  if (runs.length === 0) return [];

  let trajectory = options.trajectory;
  if ((options.by ?? 'error') === 'trajectory' && !trajectory) {
    const trees = new Map<string, readonly string[]>();
    for (const run of runs) {
      const tree = await options.store.tree(run.traceId);
      const node = tree && findNode(tree, run.id);
      if (node) trees.set(run.id, trajectoryOf(node));
    }
    trajectory = (run) => trees.get(run.id);
  }

  const cluster = { ...options, ...(trajectory ? { trajectory } : {}), minSize: options.minCount ?? 2 };
  const issues: Issue[] = [];
  const add = async (kind: Issue['kind'], members: Run[]) => {
    for (const found of await clusterRuns(members, cluster)) {
      issues.push({
        id: `${kind}-${found.id}`,
        kind,
        cluster: found,
        rate: found.count / runs.length,
        summary: `${found.count} ${kind} runs of ${found.names.join(', ')}: ${detailOf(found)}`,
      });
    }
  };
  await add(
    'failing',
    runs.filter((run) => run.status === 'error'),
  );
  if (options.slowMs !== undefined) {
    const slowMs = options.slowMs;
    await add(
      'slow',
      runs.filter((run) => run.status !== 'error' && (run.latencyMs ?? 0) >= slowMs),
    );
  }
  return issues.sort((a, b) => b.cluster.count - a.cluster.count);
}

/** A cluster's signature without the run-name prefix the error and trajectory signatures carry. */
function detailOf(cluster: RunCluster): string {
  if (cluster.by === 'meaning') return cluster.signature;
  const prefix = `${cluster.runs[0]?.name}: `;
  return cluster.signature.startsWith(prefix) ? cluster.signature.slice(prefix.length) : cluster.signature;
}

function defaultText(run: Run): string {
  if (run.error) return `${run.error.name}: ${run.error.message}`;
  return typeof run.outputs === 'string' ? run.outputs : JSON.stringify(run.outputs ?? '');
}

function defaultTrajectory(run: Run): readonly string[] | undefined {
  if ('children' in run && Array.isArray((run as RunTree).children)) return trajectoryOf(run as RunTree);
  const steps = run.metadata?.trajectory;
  return Array.isArray(steps) ? steps.map(String) : undefined;
}

function findNode(tree: RunTree, id: string): RunTree | undefined {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

/** FNV-1a, 32 bits, as hex: a short stable id for a signature. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}
