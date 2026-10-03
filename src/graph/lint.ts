import type { GraphDescription } from '../types/graph.js';

/** How much a lint finding matters: `error` fails `nexus graph lint`, the others only report. */
export type GraphLintSeverity = 'error' | 'warning' | 'info';

/** The rules `lintGraph()` checks. */
export type GraphLintCode =
  | 'UNBOUNDED_CYCLE'
  | 'RETRY_WITHOUT_IDEMPOTENCY'
  | 'RETRY_WITHOUT_TIMEOUT'
  | 'DEFERRED_DURABILITY_WITH_SIDE_EFFECTS'
  | 'MEMORY_CHECKPOINTER'
  | 'NO_CHECKPOINTER'
  | 'UNBOUNDED_CONCURRENCY'
  | 'DYNAMIC_ROUTE';

/** One design problem `lintGraph()` found. */
export interface GraphLintFinding {
  /** Which rule found it. */
  code: GraphLintCode;
  /** How much it matters. */
  severity: GraphLintSeverity;
  /** The node it is about, as a path through subgraphs such as `review/approve`. Absent for the graph itself. */
  node?: string;
  /** What is wrong. */
  message: string;
  /** What to do about it. */
  fix: string;
}

/** Options for `lintGraph()`. */
export interface GraphLintOptions {
  /**
   * The graph runs where a restart, a second replica, or a hand-off is normal: under the agent
   * server, a job queue, or more than one process. An in-process checkpointer is then an error, not
   * a note.
   */
  deployed?: boolean;
  /** Rules to skip, by code. */
  ignore?: GraphLintCode[];
}

/**
 * Finds designs that work in a demo and fail in production, by reading a compiled graph's shape.
 *
 * It needs no run and calls no node: it reads `describe()`, so it also works on a description saved
 * as JSON. The checks:
 *
 * | Code | Severity | Finds |
 * | --- | --- | --- |
 * | `UNBOUNDED_CYCLE` | error | A cycle of static edges, which only the step limit can stop |
 * | `RETRY_WITHOUT_IDEMPOTENCY` | warning | A retried node not declared `idempotent`, whose side effects can repeat |
 * | `RETRY_WITHOUT_TIMEOUT` | warning | A retried node with no timeout, whose hung attempt is never retried |
 * | `DEFERRED_DURABILITY_WITH_SIDE_EFFECTS` | warning | `async` or `exit` durability with nodes not declared `idempotent` |
 * | `MEMORY_CHECKPOINTER` | warning, or error when `deployed` | The in-process default, which a restart loses |
 * | `NO_CHECKPOINTER` | info | No checkpoints, so no interrupt, resume, or recovery |
 * | `UNBOUNDED_CONCURRENCY` | warning | A fan-out with no limit on tasks at once |
 * | `DYNAMIC_ROUTE` | info | A router with no mapping or `ends`, so routes cannot be checked |
 *
 * @example
 * ```ts
 * import { lintGraph } from 'nexus-ai-pro/graph/lint';
 *
 * const findings = lintGraph(graph, { deployed: true });
 * for (const finding of findings) console.log(finding.severity, finding.code, finding.message);
 * ```
 */
export function lintGraph(
  graph: { describe(): GraphDescription } | GraphDescription,
  options: GraphLintOptions = {},
): GraphLintFinding[] {
  const description = 'describe' in graph && typeof graph.describe === 'function' ? graph.describe() : graph;
  const findings: GraphLintFinding[] = [];
  lintDescription(description as GraphDescription, '', options, findings, true);
  const ignored = new Set(options.ignore ?? []);
  return findings.filter((finding) => !ignored.has(finding.code));
}

function lintDescription(
  description: GraphDescription,
  prefix: string,
  options: GraphLintOptions,
  findings: GraphLintFinding[],
  top: boolean,
): void {
  const at = (node: string) => `${prefix}${node}`;

  for (const cycle of staticCycles(description)) {
    findings.push({
      code: 'UNBOUNDED_CYCLE',
      severity: 'error',
      node: at(cycle[0] as string),
      message: `${cycle.map((node) => `"${at(node)}"`).join(' → ')} loop through static edges only, so the run can only stop at the step limit.`,
      fix: 'Route out of the loop with a conditional edge, a Command with declared ends, or an edge to END.',
    });
  }

  const sideEffecting: string[] = [];
  for (const node of description.nodes) {
    if (!node.idempotent) sideEffecting.push(node.id);
    if (node.retry && !node.idempotent) {
      findings.push({
        code: 'RETRY_WITHOUT_IDEMPOTENCY',
        severity: 'warning',
        node: at(node.id),
        message: `"${at(node.id)}" is retried up to ${node.maxAttempts ?? 'several'} times but is not declared idempotent, so a side effect can happen more than once.`,
        fix: 'Give its side effects an idempotency key and declare `idempotent: true`, or stop retrying it.',
      });
    }
    const timed =
      node.timeoutMs !== undefined || node.timeout?.runMs !== undefined || node.timeout?.idleMs !== undefined;
    if (node.retry && !timed) {
      findings.push({
        code: 'RETRY_WITHOUT_TIMEOUT',
        severity: 'warning',
        node: at(node.id),
        message: `"${at(node.id)}" is retried but has no timeout, so an attempt that hangs is never retried.`,
        fix: 'Set `timeout: { runMs }`, or `idleMs` with `context.heartbeat()` for long work.',
      });
    }
    if (node.subgraph) lintDescription(node.subgraph, `${at(node.id)}/`, options, findings, false);
  }

  if (!top) return;

  if ((description.durability === 'async' || description.durability === 'exit') && sideEffecting.length > 0) {
    findings.push({
      code: 'DEFERRED_DURABILITY_WITH_SIDE_EFFECTS',
      severity: 'warning',
      message: `Durability is "${description.durability}", so a crash can repeat supersteps, and ${sideEffecting.map((node) => `"${node}"`).join(', ')} ${sideEffecting.length === 1 ? 'is' : 'are'} not declared idempotent.`,
      fix: 'Use `sync` durability for graphs with side effects, or make those nodes idempotent and declare it.',
    });
  }
  if (description.checkpointer === 'memory') {
    findings.push({
      code: 'MEMORY_CHECKPOINTER',
      severity: options.deployed ? 'error' : 'warning',
      message:
        'Checkpoints go to the in-process default, so a restart loses every thread, and another process cannot resume one.',
      fix: 'Pass a persistent checkpointer, such as an OperationStoreCheckpointer over Postgres, SQLite, or Redis.',
    });
  }
  if (description.checkpointer === 'none') {
    findings.push({
      code: 'NO_CHECKPOINTER',
      severity: 'info',
      message: 'The graph writes no checkpoints, so it cannot interrupt, resume, drain, or recover after a crash.',
      fix: 'Pass a checkpointer if any of those is needed.',
    });
  }
  if (description.maxConcurrency !== undefined && !Number.isFinite(description.maxConcurrency)) {
    findings.push({
      code: 'UNBOUNDED_CONCURRENCY',
      severity: 'warning',
      message: 'Tasks in a superstep run with no limit, so a large Send fan-out starts all of them at once.',
      fix: 'Set `maxConcurrency` to what the services behind the nodes can take.',
    });
  }
  for (const node of description.dynamic) {
    findings.push({
      code: 'DYNAMIC_ROUTE',
      severity: 'info',
      node: at(node),
      message: `The router after "${at(node)}" has no mapping and the node declares no ends, so its routes cannot be checked or drawn.`,
      fix: "Give the conditional edge a mapping, or declare the node's `ends`.",
    });
  }
}

/**
 * Cycles that only static edges form. A node with a conditional edge, declared `ends`, or a router
 * that returns names decides where to go, so a loop through it can end; a loop of nodes that only
 * follow fixed edges cannot.
 */
function staticCycles(description: GraphDescription): string[][] {
  const deciding = new Set<string>(description.dynamic);
  for (const node of description.nodes) if (node.ends?.length) deciding.add(node.id);
  for (const edge of description.edges) if (edge.conditional) deciding.add(edge.from);

  const next = new Map<string, string[]>();
  for (const edge of description.edges) {
    if (edge.conditional || deciding.has(edge.from)) continue;
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }

  // Tarjan's strongly connected components over the fixed edges.
  const cycles: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of next.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node) as number, low.get(to) as number));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node) as number, index.get(to) as number));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    const selfLoop = component.length === 1 && (next.get(node) ?? []).includes(node);
    if (component.length > 1 || selfLoop) cycles.push(component.reverse());
  };
  for (const node of description.nodes) if (!index.has(node.id)) visit(node.id);
  return cycles;
}
