import type { GraphDescription } from '../types/graph.js';
import { END, START } from '../types/graph.js';
import { layoutGraph } from './layout.js';

export { type GraphLayout, type LaidOutEdge, type LaidOutNode, layoutGraph } from './layout.js';

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

/** Colours and marks for `toSvg()`. Every field has a light default. */
export interface SvgOptions {
  /** Nodes to highlight, such as `checkpoint.next`, to show where a thread is. */
  highlight?: readonly string[];
  /** Text read by screen readers and shown as the image title. Defaults to the graph's name. */
  title?: string;
  /** Colours, as any CSS colour. */
  colors?: {
    /** Canvas. Defaults to white. */
    background?: string;
    /** Node boxes. */
    node?: string;
    /** Node borders and edges. */
    line?: string;
    /** Text. */
    text?: string;
    /** Highlighted node borders. */
    highlight?: string;
    /** Edges that point back up the diagram, as cycles do. */
    back?: string;
  };
}

/**
 * Draws a graph as a standalone SVG document.
 *
 * Uses the same layered layout the studio draws with, and needs no dependency: write the string to a
 * `.svg` file, inline it in a page, or pass it to any SVG rasterizer for PNG. Solid edges are always
 * taken, dashed ones are chosen at run time, edges that go back up the diagram curve round the side,
 * and every name is escaped.
 */
export function toSvg(graph: Describable, options: SvgOptions = {}): string {
  const description = asDescription(graph);
  const layout = layoutGraph(description);
  const colors = {
    background: '#ffffff',
    node: '#f6f7f9',
    line: '#5f6670',
    text: '#1c1e21',
    highlight: '#2458d6',
    back: '#8a5a00',
    ...options.colors,
  };
  const marked = new Set(options.highlight ?? []);
  const pad = 20;
  const width = layout.width + pad * 2 + 60;
  const height = layout.height + pad * 2;
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const title = options.title ?? description.name ?? 'graph';
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${xml(title)}" font-family="system-ui, sans-serif" font-size="12">`,
    `<title>${xml(title)}</title>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><polygon points="0,0 10,5 0,10" fill="${xml(colors.line)}"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="${xml(colors.background)}"/>`,
  ];
  for (const edge of layout.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const x1 = pad + from.x + from.width / 2;
    const y1 = pad + from.y + from.height;
    const x2 = pad + to.x + to.width / 2;
    const y2 = pad + to.y;
    const d = edge.back
      ? `M ${pad + from.x + from.width} ${pad + from.y + from.height / 2} C ${pad + layout.width + 50} ${pad + from.y}, ${pad + layout.width + 50} ${pad + to.y + to.height}, ${pad + to.x + to.width} ${pad + to.y + to.height / 2}`
      : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
    parts.push(
      `<path d="${d}" fill="none" stroke="${xml(edge.back ? colors.back : colors.line)}" stroke-width="1.4"${edge.conditional ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#arrow)"/>`,
    );
    if (edge.label) {
      parts.push(
        `<text x="${(x1 + x2) / 2 + 4}" y="${(y1 + y2) / 2}" fill="${xml(colors.line)}">${xml(edge.label)}</text>`,
      );
    }
  }
  for (const node of layout.nodes) {
    const terminal = node.kind !== 'node';
    const highlighted = marked.has(node.id);
    const text =
      node.kind === 'start'
        ? 'start'
        : node.kind === 'end'
          ? 'end'
          : `${node.id}${node.defer ? ' (deferred)' : ''}${node.cache ? ' (cached)' : ''}`;
    parts.push(
      `<rect x="${pad + node.x}" y="${pad + node.y}" width="${node.width}" height="${node.height}" rx="${terminal ? node.height / 2 : 6}" fill="${xml(terminal ? colors.background : colors.node)}" stroke="${xml(highlighted ? colors.highlight : colors.line)}" stroke-width="${highlighted ? 2.5 : 1}"/>`,
      `<text x="${pad + node.x + node.width / 2}" y="${pad + node.y + node.height / 2 + 4}" text-anchor="middle" fill="${xml(colors.text)}">${xml(text)}</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
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

/** Escapes text for XML content and attribute values. */
function xml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
