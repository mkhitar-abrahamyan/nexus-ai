import type { CompletionRequest, Message } from '../types/messages.js';

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type?: string;
  properties?: Record<string, unknown>;
}

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  relation: string;
  evidence?: string;
  source?: string;
  properties?: Record<string, unknown>;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface KnowledgeGraphOptions {
  graph: KnowledgeGraph;
  query?: string;
  maxEdges?: number;
  includeFallbackFacts?: boolean;
  unknownAnswer?: string;
}

export interface SelectGraphFactsOptions {
  includeFallbackFacts?: boolean;
}

export function withKnowledgeGraphContext(
  request: CompletionRequest,
  options: KnowledgeGraphOptions,
): CompletionRequest {
  const unknownAnswer = options.unknownAnswer || "I don't know based on the provided graph.";
  const facts = selectGraphFacts(
    options.graph,
    options.query || latestUserText(request),
    options.maxEdges || 20,
    { includeFallbackFacts: options.includeFallbackFacts },
  );
  const systemMessage: Message = {
    role: 'system',
    content: [
      'Use the provided knowledge graph facts for relationship claims.',
      `If the graph does not support the answer, say: "${unknownAnswer}"`,
      'Do not infer relationships that are not present in the graph facts.',
      'Knowledge graph facts:',
      facts.length ? facts.join('\n') : '[no graph facts provided]',
    ].join('\n'),
  };

  return {
    ...request,
    temperature: request.temperature ?? 0,
    topP: request.topP ?? 0.1,
    messages: [systemMessage, ...request.messages],
    metadata: {
      ...request.metadata,
      knowledgeGraph: {
        nodes: options.graph.nodes.length,
        edges: options.graph.edges.length,
        selectedFacts: facts.length,
      },
    },
  };
}

export function selectGraphFacts(
  graph: KnowledgeGraph,
  query: string,
  maxEdges = 20,
  options: SelectGraphFactsOptions = {},
): string[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const queryTerms = new Set((query.toLowerCase().match(/[a-z0-9_'-]{2,}/g) || []));
  const includeFallbackFacts = options.includeFallbackFacts === true;

  return graph.edges
    .map((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      const text = [
        from?.label || edge.from,
        edge.relation,
        to?.label || edge.to,
        edge.evidence,
        edge.source,
      ].filter(Boolean).join(' ');
      const score = scoreText(text, queryTerms);
      return { edge, from, to, score };
    })
    .filter((item) => includeFallbackFacts || item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEdges)
    .map(({ edge, from, to }) => {
      const source = edge.source ? ` source=${edge.source}` : '';
      const evidence = edge.evidence ? ` evidence="${edge.evidence}"` : '';
      return `- ${from?.label || edge.from} --${edge.relation}--> ${to?.label || edge.to}${source}${evidence}`;
    });
}

function latestUserText(request: CompletionRequest): string {
  const message = [...request.messages].reverse().find((msg) => msg.role === 'user');
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string }).text)
    .join('\n');
}

function scoreText(text: string, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  const terms = text.toLowerCase().match(/[a-z0-9_'-]{2,}/g) || [];
  return terms.reduce((score, term) => score + (queryTerms.has(term) ? 1 : 0), 0);
}
