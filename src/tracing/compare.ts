import type { Run, RunTree } from '../types/tracing.js';

/** One field that differs between two matched runs. */
export interface RunDifference {
  /** The field, such as `status` or `outputs`. */
  path: string;
  /** How it differs. */
  kind: 'added' | 'removed' | 'changed';
  /** Its value in the left trace. */
  left?: unknown;
  /** Its value in the right trace. */
  right?: unknown;
}

/** How two traces differ. */
export interface TraceComparison {
  /** Runs present in both traces, matched by their position and name in the tree. */
  matched: Array<{ path: string; left: Run; right: Run; differences: RunDifference[] }>;
  /** Paths of runs only in the left trace. */
  onlyLeft: string[];
  /** Paths of runs only in the right trace. */
  onlyRight: string[];
  /** Right root latency minus left, in milliseconds. */
  latencyMsDelta: number;
  /** Right total cost minus left. */
  costDelta: number;
}

/**
 * Compares two traces structurally.
 *
 * "It worked yesterday" is answerable when two runs of the same thing can be laid side by side: the
 * shape that changed, the step that got slower, the tool that stopped being called. Runs are matched
 * by their path through the tree rather than by id, because two runs of the same graph never share
 * ids.
 */
export function compareTraces(left: RunTree, right: RunTree): TraceComparison {
  const leftRuns = flatten(left);
  const rightRuns = flatten(right);
  const matched: TraceComparison['matched'] = [];

  for (const [path, leftRun] of leftRuns) {
    const rightRun = rightRuns.get(path);
    if (!rightRun) continue;
    matched.push({ path, left: leftRun, right: rightRun, differences: diff(leftRun, rightRun) });
  }

  return {
    matched,
    onlyLeft: [...leftRuns.keys()].filter((path) => !rightRuns.has(path)),
    onlyRight: [...rightRuns.keys()].filter((path) => !leftRuns.has(path)),
    latencyMsDelta: (right.latencyMs ?? 0) - (left.latencyMs ?? 0),
    costDelta: totalCost(rightRuns) - totalCost(leftRuns),
  };
}

/** Each run keyed by its path: `root/child#0/grandchild#1`, stable across runs of the same shape. */
function flatten(tree: RunTree, prefix = '', into = new Map<string, Run>()): Map<string, Run> {
  const path = prefix ? `${prefix}/${tree.name}` : tree.name;
  const siblings = [...into.keys()].filter((key) => key.startsWith(`${path}#`)).length;
  const keyed = `${path}#${siblings}`;
  const { children, ...run } = tree;
  into.set(keyed, run);
  for (const child of children) flatten(child, keyed, into);
  return into;
}

function diff(left: Run, right: Run): RunDifference[] {
  const differences: RunDifference[] = [];
  for (const field of ['status', 'model', 'provider'] as const) {
    if (left[field] !== right[field]) {
      differences.push({ path: field, kind: 'changed', left: left[field], right: right[field] });
    }
  }
  if (JSON.stringify(left.inputs) !== JSON.stringify(right.inputs)) {
    differences.push({ path: 'inputs', kind: 'changed', left: left.inputs, right: right.inputs });
  }
  if (JSON.stringify(left.outputs) !== JSON.stringify(right.outputs)) {
    differences.push({ path: 'outputs', kind: 'changed', left: left.outputs, right: right.outputs });
  }
  return differences;
}

function totalCost(runs: Map<string, Run>): number {
  let total = 0;
  for (const run of runs.values()) total += run.cost ?? 0;
  return total;
}

/** A run tree as indented text, for a terminal or a log. */
export function formatTree(tree: RunTree, depth = 0): string {
  const indent = '  '.repeat(depth);
  const timing = tree.latencyMs === undefined ? '' : ` ${tree.latencyMs}ms`;
  const cost = tree.cost === undefined ? '' : ` $${tree.cost.toFixed(4)}`;
  const status = tree.status === 'ok' ? '' : ` [${tree.status}]`;
  const lines = [`${indent}${tree.kind}:${tree.name}${timing}${cost}${status}`];
  for (const child of tree.children) lines.push(formatTree(child, depth + 1));
  return lines.join('\n');
}
