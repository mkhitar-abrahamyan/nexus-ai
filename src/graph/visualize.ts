import type { GraphDescription } from '../types/graph.js';
import { END, START } from '../types/graph.js';

/** Anything that can describe itself: a compiled graph, or a description already taken from one. */
export type Describable = GraphDescription | { describe(): GraphDescription };

/** Options for `toMermaid()`. */
export interface MermaidOptions {
  /** Layout direction. Defaults to top-down. */
  direction?: 'TD' | 'LR';
  /** Draw each subgraph's nodes inside it, or show it as a single node. Defaults to `expand`. */
  subgraphs?: 'expand' | 'collapse';
  /**
   * Nodes to highlight — typically `checkpoint.next` or the nodes of the step being inspected, so a
   * diagram shows where a thread is.
   */
  highlight?: readonly string[];
}

/**
 * Renders a graph as a Mermaid flowchart.
 *
 * Mermaid rather than an image, because GitHub, GitLab, most documentation sites, and many chat tools
 * render it natively, and it diffs as text. For PNG or SVG output, pass the result to any Mermaid
 * renderer; none is bundled, so the graph runtime pays nothing for diagrams.
 *
 * Solid arrows are edges that are always taken, dotted ones are chosen at run time, and a node whose
 * router has neither a mapping nor declared `ends` points at a `?`, because its targets cannot be
 * known without running it.
 */
export function toMermaid(graph: Describable, options: MermaidOptions = {}): string {
  const description = asDescription(graph);
  const lines = [`flowchart ${options.direction ?? 'TD'}`];
  const highlighted = new Set(options.highlight ?? []);

  lines.push(`  ${id(START)}([start])`);
  lines.push(`  ${id(END)}([end])`);
  renderBody(description, '', lines, options.subgraphs ?? 'expand', highlighted);

  if (highlighted.size > 0) {
    lines.push('  classDef active fill:#fde68a,stroke:#b45309,stroke-width:2px');
    lines.push(`  class ${[...highlighted].map((node) => id(node)).join(',')} active`);
  }
  return lines.join('\n');
}

/** The description as JSON, for a UI or a test that wants the shape rather than a picture. */
export function toGraphJSON(graph: Describable): GraphDescription {
  return structuredClone(asDescription(graph));
}

function renderBody(
  description: GraphDescription,
  prefix: string,
  lines: string[],
  subgraphs: 'expand' | 'collapse',
  highlighted: Set<string>,
): void {
  const qualify = (node: string): string => (node === START || node === END || !prefix ? node : `${prefix}/${node}`);

  for (const node of description.nodes) {
    const nodeId = qualify(node.id);
    if (node.subgraph && subgraphs === 'expand') {
      lines.push(`  subgraph ${id(nodeId)}["${label(node.id)}"]`);
      renderBody(node.subgraph, nodeId, lines, subgraphs, highlighted);
      lines.push('  end');
      continue;
    }
    const notes = [node.defer ? 'deferred' : '', node.retry ? 'retries' : ''].filter(Boolean);
    const text = notes.length > 0 ? `${label(node.id)}<br/><small>${notes.join(', ')}</small>` : label(node.id);
    lines.push(`  ${id(nodeId)}["${text}"]`);
  }

  // Inside an expanded subgraph, START and END are the subgraph's own boundary, drawn as its box.
  const inner = prefix !== '';
  for (const edge of description.edges) {
    if (inner && (edge.from === START || edge.to === END)) continue;
    const from = qualify(edge.from);
    const to = qualify(edge.to);
    const arrow = edge.conditional ? '-.->' : '-->';
    const text = edge.label ? `|${label(edge.label)}|` : '';
    lines.push(`  ${id(from)} ${arrow}${text} ${id(to)}`);
  }

  for (const node of description.dynamic) {
    const unknown = `${qualify(node)}?`;
    lines.push(`  ${id(unknown)}{{"?"}}`);
    lines.push(`  ${id(qualify(node))} -.-> ${id(unknown)}`);
  }
}

function asDescription(graph: Describable): GraphDescription {
  return 'describe' in graph && typeof graph.describe === 'function' ? graph.describe() : (graph as GraphDescription);
}

/** Mermaid ids allow letters, digits, and underscores; anything else is folded to keep them valid. */
function id(node: string): string {
  if (node === START) return '__start__';
  if (node === END) return '__end__';
  return `n_${node.replace(/[^A-Za-z0-9_]/g, (character) => `_${character.charCodeAt(0).toString(16)}_`)}`;
}

function label(text: string): string {
  return text.replace(/"/g, '#quot;');
}
