import type { CompletionRequest } from '../types/messages.js';
import type { SecurityFinding } from '../types/security.js';

/** One field that does not match, with its path from the request's root. */
interface Issue {
  path: Array<string | number>;
  message: string;
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MEDIA_PARTS = new Set(['image', 'audio', 'video']);

/**
 * Validates a request's shape before it is sent.
 *
 * The checks are written out rather than declared through a schema library, so the security
 * pipeline, which runs on every request, adds no dependency to the install.
 */
export class SchemaValidator {
  /** Findings for every field that does not match the request schema. */
  validate(request: CompletionRequest): SecurityFinding[] {
    return requestIssues(request).map((issue) => ({
      type: 'schema',
      severity: 'high',
      message: issue.message,
      path: issue.path.join('.'),
    }));
  }
}

function requestIssues(request: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isRecord(request)) return [{ path: [], message: 'The request must be an object' }];

  if (typeof request.model !== 'string' || request.model.length === 0) {
    issues.push({ path: ['model'], message: 'model must be a non-empty string' });
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    issues.push({ path: ['messages'], message: 'messages must be an array with at least one message' });
  } else {
    for (const [index, message] of request.messages.entries()) messageIssues(message, ['messages', index], issues);
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) issues.push({ path: ['tools'], message: 'tools must be an array' });
    else for (const [index, tool] of request.tools.entries()) toolIssues(tool, ['tools', index], issues);
  }

  numberIn(request, 'temperature', 0, 2, issues);
  numberIn(request, 'topP', 0, 1, issues);
  if (
    request.maxTokens !== undefined &&
    !(typeof request.maxTokens === 'number' && Number.isInteger(request.maxTokens) && request.maxTokens > 0)
  ) {
    issues.push({ path: ['maxTokens'], message: 'maxTokens must be a positive integer' });
  }
  if (
    request.stop !== undefined &&
    typeof request.stop !== 'string' &&
    !(Array.isArray(request.stop) && request.stop.every((item) => typeof item === 'string'))
  ) {
    issues.push({ path: ['stop'], message: 'stop must be a string or an array of strings' });
  }
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    issues.push({ path: ['stream'], message: 'stream must be a boolean' });
  }
  optionalString(request, 'userId', [], issues);
  if (request.metadata !== undefined && !isRecord(request.metadata)) {
    issues.push({ path: ['metadata'], message: 'metadata must be an object' });
  }
  return issues;
}

function messageIssues(message: unknown, path: Array<string | number>, issues: Issue[]): void {
  if (!isRecord(message)) {
    issues.push({ path, message: 'A message must be an object' });
    return;
  }
  if (typeof message.role !== 'string' || !ROLES.has(message.role)) {
    issues.push({ path: [...path, 'role'], message: 'role must be system, user, assistant, or tool' });
  }
  if (Array.isArray(message.content)) {
    for (const [index, part] of message.content.entries()) partIssues(part, [...path, 'content', index], issues);
  } else if (typeof message.content !== 'string') {
    issues.push({ path: [...path, 'content'], message: 'content must be a string or an array of parts' });
  }
  optionalString(message, 'name', path, issues);
  optionalString(message, 'toolCallId', path, issues);
  if (message.toolCalls !== undefined) {
    if (!Array.isArray(message.toolCalls)) {
      issues.push({ path: [...path, 'toolCalls'], message: 'toolCalls must be an array' });
      return;
    }
    message.toolCalls.forEach((call, index) => {
      const callPath = [...path, 'toolCalls', index];
      const fn = isRecord(call) ? call.function : undefined;
      if (
        !isRecord(call) ||
        typeof call.id !== 'string' ||
        call.type !== 'function' ||
        !isRecord(fn) ||
        typeof fn.name !== 'string' ||
        typeof fn.arguments !== 'string'
      ) {
        issues.push({
          path: callPath,
          message: 'A tool call needs a string id, type "function", and a function with a string name and arguments',
        });
      }
    });
  }
}

function partIssues(part: unknown, path: Array<string | number>, issues: Issue[]): void {
  if (!isRecord(part)) {
    issues.push({ path, message: 'A content part must be an object' });
    return;
  }
  if (part.type === 'text') {
    if (typeof part.text !== 'string')
      issues.push({ path: [...path, 'text'], message: 'A text part needs a string text' });
    return;
  }
  if (typeof part.type === 'string' && MEDIA_PARTS.has(part.type)) {
    if (!isRecord(part.source)) {
      issues.push({ path: [...path, 'source'], message: `The ${part.type} part needs a source object` });
    }
    return;
  }
  if (part.type === 'asset') {
    const asset = part.asset;
    if (!isRecord(asset) || !isRecord(asset.location) || typeof asset.mimeType !== 'string') {
      issues.push({ path: [...path, 'asset'], message: 'An asset part needs an asset with a location and a mimeType' });
    }
    return;
  }
  issues.push({ path: [...path, 'type'], message: 'A part type must be text, image, audio, video, or asset' });
}

function toolIssues(tool: unknown, path: Array<string | number>, issues: Issue[]): void {
  if (!isRecord(tool)) {
    issues.push({ path, message: 'A tool must be an object' });
    return;
  }
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    issues.push({ path: [...path, 'name'], message: 'A tool needs a non-empty name' });
  }
  if (typeof tool.description !== 'string' || tool.description.length === 0) {
    issues.push({ path: [...path, 'description'], message: 'A tool needs a non-empty description' });
  }
  if (!isRecord(tool.parameters)) {
    issues.push({ path: [...path, 'parameters'], message: 'A tool needs a JSON Schema object for its parameters' });
  }
  if (tool.execute !== undefined && typeof tool.execute !== 'function') {
    issues.push({ path: [...path, 'execute'], message: 'A tool execute must be a function' });
  }
}

function numberIn(record: Record<string, unknown>, key: string, min: number, max: number, issues: Issue[]): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
    issues.push({ path: [key], message: `${key} must be a number from ${min} to ${max}` });
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: Array<string | number>,
  issues: Issue[],
): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    issues.push({ path: [...path, key], message: `${key} must be a string` });
  }
}

/** A plain object: not null, and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
