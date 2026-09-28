import type { GraphDescription } from '../types/graph.js';

/** A node placed on the diagram. */
export interface LaidOutNode {
  /** The node's id. */
  id: string;
  /** Left edge, in diagram units. */
  x: number;
  /** Top edge, in diagram units. */
  y: number;
  /** Box width. */
  width: number;
  /** Box height. */
  height: number;
  /** `start` and `end` are the graph's entry and exit; everything else is a `node`. */
  kind: 'start' | 'end' | 'node';
  /** True when the node waits for every branch before it runs. */
  defer?: boolean;
  /** True when the node reuses results through a cache. */
  cache?: boolean;
}

/** An edge between two placed nodes. */
export interface LaidOutEdge {
  /** The node it leaves. */
  from: string;
  /** The node it reaches. */
  to: string;
  /** Chosen by a router rather than always taken. */
  conditional?: boolean;
  /** The router's key for this branch. */
  label?: string;
  /** True when it points back up the diagram, as a cycle does. */
  back: boolean;
}

/** A graph laid out for drawing. */
export interface GraphLayout {
  /** Every node, placed. */
  nodes: LaidOutNode[];
  /** Every edge. */
  edges: LaidOutEdge[];
  /** Diagram width. */
  width: number;
  /** Diagram height. */
  height: number;
}

const START = '__start__';
const END = '__end__';
const NODE_WIDTH = 150;
const NODE_HEIGHT = 40;
const GAP_X = 40;
const GAP_Y = 60;

/**
 * Lays a graph out in layers: each node sits one layer below the nearest node that leads to it.
 *
 * Breadth-first distance rather than longest path, so a cycle cannot push a node down forever; an
 * edge that goes back up is marked, and the drawing curves it round the side. Done here rather than
 * in the browser so neither the studio nor `toSvg()` needs a diagram library, and so the layout can be
 * tested.
 */
export function layoutGraph(graph: GraphDescription | { describe(): GraphDescription }): GraphLayout {
  const description =
    'describe' in graph && typeof graph.describe === 'function' ? graph.describe() : (graph as GraphDescription);
  const ids = [START, ...description.nodes.map((node) => node.id), END];
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of description.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!outgoing.has(edge.to)) outgoing.set(edge.to, []);
    (outgoing.get(edge.from) as string[]).push(edge.to);
  }

  const layer = new Map<string, number>([[START, 0]]);
  const queue = [START];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (layer.has(next)) continue;
      layer.set(next, (layer.get(current) as number) + 1);
      queue.push(next);
    }
  }
  // Unreachable nodes still appear, below everything reachable, so nothing silently disappears.
  let deepest = Math.max(0, ...[...layer.values()]);
  for (const id of outgoing.keys()) {
    if (!layer.has(id) && id !== END) layer.set(id, ++deepest);
  }
  // The exit is always at the bottom.
  layer.set(END, Math.max(deepest, ...[...layer.entries()].filter(([id]) => id !== END).map(([, value]) => value)) + 1);

  const rows = new Map<number, string[]>();
  for (const [id, row] of layer) rows.set(row, [...(rows.get(row) ?? []), id]);
  const widest = Math.max(...[...rows.values()].map((row) => row.length));
  const width = widest * NODE_WIDTH + (widest - 1) * GAP_X;

  const options = new Map(description.nodes.map((node) => [node.id, node]));
  const nodes: LaidOutNode[] = [];
  for (const [row, members] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const rowWidth = members.length * NODE_WIDTH + (members.length - 1) * GAP_X;
    const offset = (width - rowWidth) / 2;
    members.forEach((id, index) => {
      const node = options.get(id);
      nodes.push({
        id,
        x: offset + index * (NODE_WIDTH + GAP_X),
        y: row * (NODE_HEIGHT + GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        kind: id === START ? 'start' : id === END ? 'end' : 'node',
        ...(node?.defer ? { defer: true } : {}),
        ...(node?.cache ? { cache: true } : {}),
      });
    });
  }

  const edges: LaidOutEdge[] = description.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    ...(edge.conditional ? { conditional: true } : {}),
    ...(edge.label ? { label: edge.label } : {}),
    back: (layer.get(edge.to) ?? 0) <= (layer.get(edge.from) ?? 0),
  }));

  const rowsCount = Math.max(...[...rows.keys()]) + 1;
  return { nodes, edges, width, height: rowsCount * NODE_HEIGHT + (rowsCount - 1) * GAP_Y };
}
