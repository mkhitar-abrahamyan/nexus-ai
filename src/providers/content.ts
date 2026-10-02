import type { AssetInput } from '../types/images.js';
import type { ImageContent, Message } from '../types/messages.js';
import type { ToolCall } from '../types/response.js';

/**
 * One line naming an asset by where it lives, for a model to read and repeat back to a tool. Bytes
 * are never written out: an asset held in memory is named by its type and size.
 */
export function assetReference(asset: AssetInput): string {
  const name = asset.filename ? ` "${asset.filename}"` : '';
  const location = asset.location;
  if (location.kind === 'stored')
    return `[asset${name} ${asset.mimeType} stored as ${location.assetId} at ${location.uri}]`;
  if (location.kind === 'url') return `[asset${name} ${asset.mimeType} at ${location.url}]`;
  return `[asset${name} ${asset.mimeType}, ${location.data.byteLength} bytes held by the application]`;
}

/** What an image part resolves to on the wire: base64 data, a URL, or nothing a provider can read. */
export type WireImage = { kind: 'base64'; mimeType: string; data: string } | { kind: 'url'; url: string } | undefined;

/** Reads an image part as base64 data or a URL, whichever it holds. */
export function wireImage(part: ImageContent): WireImage {
  const source = part.source;
  if ('url' in source) return { kind: 'url', url: source.url };
  if ('base64' in source) return { kind: 'base64', mimeType: source.mimeType || 'image/png', data: source.base64 };
  if ('buffer' in source) {
    return { kind: 'base64', mimeType: source.mimeType || 'image/png', data: toBase64(source.buffer) };
  }
  if ('asset' in source) {
    const location = source.asset.location;
    if (location.kind === 'bytes')
      return { kind: 'base64', mimeType: source.asset.mimeType, data: toBase64(location.data) };
    if (location.kind === 'url') return { kind: 'url', url: location.url };
  }
  return undefined;
}

/** The text an image part stands for when a provider cannot receive it. */
export function imagePlaceholder(part: ImageContent): string {
  const source = part.source;
  if ('asset' in source) return assetReference(source.asset);
  if ('path' in source) return '[image from path requires preprocessing]';
  return '[image]';
}

/** A message's text, with asset parts as references and other media left out. */
export function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : part.type === 'asset' ? assetReference(part.asset) : ''))
    .filter(Boolean)
    .join('\n');
}

/** The image parts of a message, in order. */
export function imagesOf(content: Message['content']): ImageContent[] {
  return typeof content === 'string' ? [] : content.filter((part): part is ImageContent => part.type === 'image');
}

/** Parses a tool call's arguments for a provider that wants an object, keeping malformed JSON as text. */
export function toolArguments(call: ToolCall): Record<string, unknown> {
  if (!call.function.arguments?.trim()) return {};
  try {
    const parsed = JSON.parse(call.function.arguments) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { arguments: call.function.arguments };
  }
}

/** The name of the tool a result answers, found from the assistant message that called it. */
export function toolNameFor(messages: Message[], index: number): string | undefined {
  const message = messages[index];
  if (message?.name) return message.name;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const call = messages[cursor]?.toolCalls?.find((candidate) => candidate.id === message?.toolCallId);
    if (call) return call.function.name;
  }
  return undefined;
}

function toBase64(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (buffer) return buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
