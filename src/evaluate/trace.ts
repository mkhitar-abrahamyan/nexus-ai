/**
 * What a run did, read from its trace, for evaluators that judge more than the final answer: the
 * tools it called, the documents it retrieved, the model calls it made, and every image, audio clip,
 * video, and document it received or produced.
 */
import type {
  EvaluationTrace,
  MediaPart,
  TraceDocument,
  TraceMedia,
  TraceModelCall,
  TraceRetrieval,
  TraceToolCall,
} from '../types/evaluate.js';
import type { RunTree } from '../types/tracing.js';

/** How deep `mediaParts()` looks inside a value. Messages, tool outputs, and results nest a few levels. */
const MAX_DEPTH = 12;

/**
 * Reads a trace into what evaluators judge: its root's inputs and outputs, every tool call,
 * retrieval, and model call beneath it in the order they started, and the media they carried, each
 * medium once.
 */
export function traceEvidence(root: RunTree): EvaluationTrace {
  const toolCalls: TraceToolCall[] = [];
  const retrievals: TraceRetrieval[] = [];
  const modelCalls: TraceModelCall[] = [];
  const media: TraceMedia[] = [];
  const seen = new Set<string>();
  const collect = (value: unknown, direction: TraceMedia['direction'], node: RunTree): void => {
    for (const part of mediaParts(value)) {
      const key = fingerprint(part);
      if (seen.has(key)) continue;
      seen.add(key);
      media.push({ part, direction, runId: node.id, kind: node.kind });
    }
  };
  const visit = (node: RunTree): void => {
    const common = {
      runId: node.id,
      ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
      ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
      ...(node.error ? { error: node.error } : {}),
      ...(node.latencyMs === undefined ? {} : { latencyMs: node.latencyMs }),
    };
    if (node.kind === 'tool') toolCalls.push({ name: node.name, ...common });
    else if (node.kind === 'model') {
      modelCalls.push({
        ...common,
        ...(node.model ? { model: node.model } : {}),
        ...(node.provider ? { provider: node.provider } : {}),
        ...(node.usage ? { usage: node.usage } : {}),
        ...(node.cost === undefined ? {} : { cost: node.cost }),
      });
    } else if (node.kind === 'retriever') {
      const query = queryOf(node.inputs);
      retrievals.push({
        runId: node.id,
        ...(query === undefined ? {} : { query }),
        documents: documentsOf(node.outputs),
        ...(node.error ? { error: node.error } : {}),
      });
    }
    collect(node.inputs, 'input', node);
    collect(node.outputs, 'output', node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return {
    root,
    ...(root.inputs === undefined ? {} : { inputs: root.inputs }),
    ...(root.outputs === undefined ? {} : { outputs: root.outputs }),
    toolCalls,
    retrievals,
    modelCalls,
    media,
  };
}

/**
 * Every image, audio, video, document, and asset part inside a value, in the order they appear: a
 * message's content, a tool's output, a list of them, or an asset an image or video operation
 * returned, which comes back as an asset part.
 */
export function mediaParts(value: unknown): MediaPart[] {
  const found: MediaPart[] = [];
  const seen = new Set<object>();
  const walk = (item: unknown, depth: number): void => {
    if (item === null || typeof item !== 'object' || depth > MAX_DEPTH || seen.has(item)) return;
    // Bytes are a medium's content, never a container of media.
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry, depth + 1);
      return;
    }
    const part = asMediaPart(item as Record<string, unknown>);
    if (part) {
      found.push(part);
      return;
    }
    for (const entry of Object.values(item)) walk(entry, depth + 1);
  };
  walk(value, 0);
  return found;
}

/** The value as a media part, when it is one: a typed part, or an asset an operation returned. */
export function asMediaPart(item: Record<string, unknown>): MediaPart | undefined {
  const type = item.type;
  const source = item.source;
  if (
    (type === 'image' || type === 'audio' || type === 'video' || type === 'document') &&
    source !== null &&
    typeof source === 'object'
  ) {
    return item as unknown as MediaPart;
  }
  if (type === 'asset' && isAsset(item.asset)) return item as unknown as MediaPart;
  // An asset an image or video operation returned, or one read from an asset store.
  if (type === undefined && isAsset(item)) return { type: 'asset', asset: item as never };
  return undefined;
}

function isAsset(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const asset = value as { mimeType?: unknown; location?: { kind?: unknown } };
  const kind = asset.location?.kind;
  return typeof asset.mimeType === 'string' && (kind === 'bytes' || kind === 'url' || kind === 'stored');
}

/** Identifies a medium cheaply, so one carried by several runs is listed once. */
function fingerprint(part: MediaPart): string {
  const where =
    part.type === 'asset'
      ? part.asset.location
      : ((part as { source: Record<string, unknown> }).source as Record<string, unknown>);
  const record = where as Record<string, unknown>;
  for (const field of ['assetId', 'url', 'path', 'uri', 'transcript'] as const) {
    if (typeof record[field] === 'string') return `${part.type}:${field}:${record[field]}`;
  }
  const text = typeof record.base64 === 'string' ? record.base64 : undefined;
  if (text !== undefined) return `${part.type}:b64:${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
  const bytes = (record.buffer ?? record.data) as ArrayLike<number> | undefined;
  if (bytes && typeof bytes.length === 'number') {
    let sample = '';
    const step = Math.max(1, Math.floor(bytes.length / 32));
    for (let index = 0; index < bytes.length; index += step) sample += `${bytes[index]},`;
    return `${part.type}:bytes:${bytes.length}:${sample}`;
  }
  return `${part.type}:${JSON.stringify(record).slice(0, 200)}`;
}

function queryOf(inputs: unknown): string | undefined {
  if (typeof inputs === 'string') return inputs;
  if (inputs && typeof inputs === 'object') {
    const query = (inputs as { query?: unknown }).query;
    if (typeof query === 'string') return query;
    if (Array.isArray(inputs) && typeof inputs[0] === 'string') return inputs[0];
  }
  return undefined;
}

function documentsOf(outputs: unknown): TraceDocument[] {
  const list = Array.isArray(outputs)
    ? outputs
    : outputs && typeof outputs === 'object' && Array.isArray((outputs as { documents?: unknown }).documents)
      ? ((outputs as { documents: unknown[] }).documents as unknown[])
      : [];
  return list.map((entry) => {
    if (typeof entry === 'string') return { content: entry };
    const document = (entry ?? {}) as Record<string, unknown>;
    const content = document.content ?? document.text ?? document.pageContent;
    return {
      content: typeof content === 'string' ? content : JSON.stringify(entry),
      ...(typeof document.id === 'string' ? { id: document.id } : {}),
      ...(typeof document.score === 'number' ? { score: document.score } : {}),
      ...(typeof document.source === 'string' ? { source: document.source } : {}),
      ...(document.metadata && typeof document.metadata === 'object'
        ? { metadata: document.metadata as Record<string, unknown> }
        : {}),
    };
  });
}
