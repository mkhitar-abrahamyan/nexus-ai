/**
 * Tools read from a service's own API description, an OpenAPI document: one tool per operation, its
 * name, description, and parameters the service's, the capabilities it declares read from its method,
 * and what it returns kept as a schema. Given where the API lives, each tool calls it; without, the
 * tools describe the API and run nowhere, as `emulatedTools()` wants them.
 */
import type { ToolContext, ToolDefinition } from '../types/messages.js';
import { linkSignals } from '../utils/signals.js';

/** An OpenAPI 3 document, as parsed JSON. Only what tools are read from is typed. */
export interface OpenApiDocument {
  /** The OpenAPI version, `3.0.x` or `3.1.x`. */
  openapi: string;
  /** The API's title and version. */
  info?: { title?: string; version?: string; description?: string };
  /** Where the API is served. */
  servers?: Array<{ url: string; variables?: Record<string, { default: string }> }>;
  /** Its operations, by path and method. */
  paths?: Record<string, Record<string, unknown>>;
  /** Schemas, parameters, request bodies, and responses its operations refer to. */
  components?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One operation of the API, as a tool reads it. */
export interface OpenApiOperation {
  /** The tool's name: the operation's id, or its method and path. */
  name: string;
  /** The HTTP method, in capitals. */
  method: string;
  /** The path, with its `{parameters}`. */
  path: string;
  /** The operation's id, when it has one. */
  operationId?: string;
  /** Its summary, when it has one. */
  summary?: string;
  /** Its tags. */
  tags: string[];
  /** What it does to the service, read from its method: `read` for GET, HEAD, OPTIONS, and TRACE, `destructive` for DELETE, and `write` for the rest. */
  access: 'read' | 'write' | 'destructive';
}

/** What a tool's headers are chosen from: the operation, and the call's context. */
export interface OpenApiHeadersRequest {
  /** The operation being called. */
  operation: OpenApiOperation;
  /** The call's context: its tenant, principal, and thread. */
  context?: ToolContext;
}

/** Options for `openApiTools()`. */
export interface OpenApiToolsOptions {
  /** The API's name, in each tool's capabilities. Defaults to its title, as a slug, or `api`. */
  name?: string;
  /**
   * Where the API lives, its path prefix included, such as `https://shop.example.com/api`. Defaults
   * to the document's first server, resolved against `documentUrl` when relative. Without one, the
   * tools describe the API and run nowhere.
   */
  baseUrl?: string;
  /** Where the document came from, to resolve a relative server URL against. */
  documentUrl?: string;
  /**
   * Headers every call sends, such as authorization, or a function choosing them per operation and
   * call, such as by its tenant. They win over a header parameter the model sets.
   */
  headers?:
    | Readonly<Record<string, string>>
    | ((request: OpenApiHeadersRequest) => Record<string, string> | Promise<Record<string, string>>);
  /** Which operations become tools. Defaults to every one. */
  include?: (operation: OpenApiOperation) => boolean;
  /** Put before every tool's name, with an underscore, so two APIs' operations stay apart. */
  prefix?: string;
  /** How long a call may take, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** The largest answer a call reads, in bytes; a larger one fails the call. Defaults to 1 MB. */
  maxResponseBytes?: number;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** An API's operations as tools, with what each returns. */
export interface OpenApiTools {
  /** The API's name, as its tools' capabilities carry it. */
  name: string;
  /** Where the tools send their calls, when they run. */
  baseUrl?: string;
  /** One tool per operation. */
  tools: ToolDefinition[];
  /** The operations, in the tools' order. */
  operations: OpenApiOperation[];
  /** The JSON Schema of what each tool returns, by name: its first success response's. Pass it to `emulatedTools()` as `results`. */
  results: Record<string, Record<string, unknown>>;
  /** Operations that could not become tools, and why: a request body of a type the tools do not send. */
  skipped: Array<{ method: string; path: string; reason: string }>;
}

/** Why an API could not be read into tools, or a call to it failed. */
export class OpenApiError extends Error {
  constructor(
    message: string,
    /**
     * `OPENAPI_INVALID` for a malformed document or call, `OPENAPI_UNSUPPORTED` for one these tools
     * cannot read, such as Swagger 2.0 or a reference outside the document, and `OPENAPI_REQUEST`
     * for a call the API refused or did not answer.
     */
    readonly code: 'OPENAPI_INVALID' | 'OPENAPI_UNSUPPORTED' | 'OPENAPI_REQUEST',
    /** The HTTP status the API answered with, when it did. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenApiError';
  }
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
/** Header parameters OpenAPI says are ignored: the client sets them itself. */
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
/** Keywords OpenAPI adds to JSON Schema, which a model's tool schema does not take. */
const OPENAPI_ONLY = new Set(['nullable', 'example', 'xml', 'externalDocs', 'discriminator']);

/** Where each argument goes in the request. */
interface Placement {
  arg: string;
  name: string;
  in: 'path' | 'query' | 'header' | 'body-field' | 'body';
}

/**
 * Reads an OpenAPI 3 document into tools, one per operation: named by its `operationId`, or its
 * method and path; described by its summary; its path, query, and header parameters, and the fields
 * of a JSON body, as the tool's parameters. Each declares `api.read`, `api.write`, or
 * `api.destructive` with the API's name and its own, as its method says, and `network` for the
 * API's host when it runs. References within the document are followed; one outside it is refused.
 *
 * ```ts
 * const shop = openApiTools(JSON.parse(await readFile('shop.openapi.json', 'utf8')), {
 *   baseUrl: 'https://shop.example.com/api',
 *   headers: { authorization: `Bearer ${process.env.SHOP_TOKEN}` },
 * });
 * const agent = createAgent({ client: ai, tools: shop.tools });
 * ```
 */
export function openApiTools(document: OpenApiDocument | string, options: OpenApiToolsOptions = {}): OpenApiTools {
  const doc = parseDocument(document);
  const apiName = options.name ?? (slug(doc.info?.title ?? '') || 'api');
  const baseUrl = baseOf(doc, options);
  const tools: ToolDefinition[] = [];
  const operations: OpenApiOperation[] = [];
  const results: Record<string, Record<string, unknown>> = {};
  const skipped: OpenApiTools['skipped'] = [];
  const used = new Set<string>();

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const pathItem = deref(doc, item) as Record<string, unknown>;
    for (const method of METHODS) {
      const raw = pathItem[method];
      if (!isRecord(raw)) continue;
      const operationId = typeof raw.operationId === 'string' ? raw.operationId : undefined;
      const name = uniqueName(
        [options.prefix, sanitize(operationId ?? `${method}_${path}`) || method].filter(Boolean).join('_'),
        used,
      );
      const operation: OpenApiOperation = {
        name,
        method: method.toUpperCase(),
        path,
        ...(operationId ? { operationId } : {}),
        ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        access:
          method === 'delete' ? 'destructive' : ['get', 'head', 'options', 'trace'].includes(method) ? 'read' : 'write',
      };
      if (options.include && !options.include(operation)) {
        used.delete(name);
        continue;
      }
      const built = buildOperation(doc, pathItem, raw);
      if ('skip' in built) {
        used.delete(name);
        skipped.push({ method: operation.method, path, reason: built.skip });
        continue;
      }
      operations.push(operation);
      if (built.result) results[name] = built.result;
      tools.push({
        name,
        description: describe(raw, operation),
        parameters: built.parameters,
        capabilities: [
          `api.${operation.access}:${apiName}/${name}`,
          ...(baseUrl ? [`network:${new URL(baseUrl).host}`] : []),
        ],
        ...(baseUrl ? { execute: caller(operation, built.placements, built.bodyType, baseUrl, options) } : {}),
      });
    }
  }
  return { name: apiName, ...(baseUrl ? { baseUrl } : {}), tools, operations, results, skipped };
}

/** Fetches an OpenAPI document, as JSON, and reads it into tools, resolving its servers against where it came from. */
export async function loadOpenApiTools(url: string, options: OpenApiToolsOptions = {}): Promise<OpenApiTools> {
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok)
    throw new OpenApiError(
      `The OpenAPI document at ${url} answered ${response.status}`,
      'OPENAPI_REQUEST',
      response.status,
    );
  return openApiTools(await response.text(), { documentUrl: url, ...options });
}

// ── Reading the document ────────────────────────────────────────────

function parseDocument(document: OpenApiDocument | string): OpenApiDocument {
  let doc: unknown = document;
  if (typeof document === 'string') {
    try {
      doc = JSON.parse(document);
    } catch {
      throw new OpenApiError(
        'The OpenAPI document is not JSON; parse a YAML document first, and pass the object',
        'OPENAPI_INVALID',
      );
    }
  }
  if (!isRecord(doc)) throw new OpenApiError('An OpenAPI document is an object', 'OPENAPI_INVALID');
  if (typeof doc.swagger === 'string') {
    throw new OpenApiError(
      `Swagger ${doc.swagger} is not read; convert the document to OpenAPI 3`,
      'OPENAPI_UNSUPPORTED',
    );
  }
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new OpenApiError(
      `An OpenAPI 3 document names its version in "openapi", not ${JSON.stringify(doc.openapi)}`,
      'OPENAPI_INVALID',
    );
  }
  return doc as OpenApiDocument;
}

function baseOf(doc: OpenApiDocument, options: OpenApiToolsOptions): string | undefined {
  if (options.baseUrl) {
    try {
      return new URL(options.baseUrl).href.replace(/\/+$/, '');
    } catch {
      throw new OpenApiError(
        `baseUrl must be an absolute URL, not ${JSON.stringify(options.baseUrl)}`,
        'OPENAPI_INVALID',
      );
    }
  }
  const server = doc.servers?.[0];
  if (!server || typeof server.url !== 'string') return undefined;
  const url = server.url.replace(/\{([^}]+)\}/g, (_match, name: string) => server.variables?.[name]?.default ?? '');
  try {
    return new URL(url, options.documentUrl).href.replace(/\/+$/, '');
  } catch {
    // Relative, with nothing to resolve it against: the tools describe the API and run nowhere.
    return undefined;
  }
}

/** Follows a reference within the document; a value that is not one is returned as it is. */
function deref(doc: OpenApiDocument, value: unknown, seen: readonly string[] = []): unknown {
  if (!isRecord(value) || typeof value.$ref !== 'string') return value;
  const ref = value.$ref;
  if (seen.includes(ref)) throw new OpenApiError(`${ref} refers to itself`, 'OPENAPI_INVALID');
  return deref(doc, resolve(doc, ref), [...seen, ref]);
}

function resolve(doc: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith('#')) {
    throw new OpenApiError(
      `${ref} is outside the document; only references within it are followed`,
      'OPENAPI_UNSUPPORTED',
    );
  }
  let node: unknown = doc;
  for (const part of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    node = isRecord(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
    if (node === undefined) throw new OpenApiError(`${ref} names nothing in the document`, 'OPENAPI_INVALID');
  }
  return node;
}

/**
 * A schema as a model's tool takes it: references followed, a reference back to one still being
 * read left as a description, OpenAPI's own keywords converted or dropped, and the properties a
 * request or a response must not carry left out.
 */
function schemaOf(
  doc: OpenApiDocument,
  schema: unknown,
  omit: 'readOnly' | 'writeOnly',
  seen: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    if (seen.includes(ref)) return { description: `The same shape as ${ref.split('/').at(-1)}, nested` };
    const { $ref: _ref, ...siblings } = schema;
    return { ...schemaOf(doc, resolve(doc, ref), omit, [...seen, ref]), ...schemaOf(doc, siblings, omit, seen) };
  }
  const out: Record<string, unknown> = {};
  const one = (value: unknown) => (isRecord(value) ? schemaOf(doc, value, omit, seen) : value);
  const many = (value: unknown) => (Array.isArray(value) ? value.map(one) : value);
  const each = (value: unknown) =>
    isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, one(item)])) : value;
  for (const [key, value] of Object.entries(schema)) {
    if (OPENAPI_ONLY.has(key)) continue;
    if (key === 'properties' && isRecord(value)) {
      const kept: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(value)) {
        const read = schemaOf(doc, property, omit, seen);
        if (read[omit] === true) continue;
        kept[name] = read;
      }
      out.properties = kept;
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) out[key] = many(value);
    else if (['$defs', 'definitions', 'patternProperties', 'dependentSchemas'].includes(key)) out[key] = each(value);
    else if (
      ['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else'].includes(key)
    ) {
      out[key] = one(value);
    } else out[key] = value;
  }
  if (Array.isArray(out.required) && isRecord(out.properties)) {
    const properties = out.properties;
    out.required = out.required.filter((name) => typeof name === 'string' && name in properties);
    if ((out.required as unknown[]).length === 0) delete out.required;
  }
  // OpenAPI 3.0's `nullable` is JSON Schema's null type; its `example`, JSON Schema's `examples`.
  if (schema.nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
  }
  if ('example' in schema && !('examples' in schema)) out.examples = [schema.example];
  return out;
}

/** An operation's parameters, where each argument goes, and what it returns; or why it is skipped. */
function buildOperation(
  doc: OpenApiDocument,
  pathItem: Record<string, unknown>,
  raw: Record<string, unknown>,
):
  | { skip: string }
  | {
      parameters: Record<string, unknown>;
      placements: Placement[];
      bodyType?: 'json' | 'form';
      result?: Record<string, unknown>;
    } {
  // Parameters of the path item, replaced by the operation's own of the same name and place.
  const declared = new Map<string, Record<string, unknown>>();
  for (const list of [pathItem.parameters, raw.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const parameter = deref(doc, item);
      if (!isRecord(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue;
      declared.set(`${parameter.in}\u0000${parameter.name}`, parameter);
    }
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const placements: Placement[] = [];
  for (const parameter of declared.values()) {
    const place = parameter.in as string;
    const name = parameter.name as string;
    if (place === 'cookie' || (place === 'header' && IGNORED_HEADERS.has(name.toLowerCase()))) continue;
    if (place !== 'path' && place !== 'query' && place !== 'header') continue;
    const arg = name in properties ? `${place}_${name}` : name;
    const content = isRecord(parameter.content) ? Object.values(parameter.content)[0] : undefined;
    const schema = schemaOf(doc, parameter.schema ?? (isRecord(content) ? content.schema : undefined), 'readOnly');
    properties[arg] = {
      ...schema,
      ...(typeof parameter.description === 'string' && !schema.description
        ? { description: parameter.description }
        : {}),
    };
    if (place === 'path' || parameter.required === true) required.push(arg);
    placements.push({ arg, name, in: place });
  }

  let bodyType: 'json' | 'form' | undefined;
  const body = deref(doc, raw.requestBody);
  if (isRecord(body) && isRecord(body.content)) {
    const types = Object.keys(body.content);
    const json = types.find((type) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(type));
    const form = types.find((type) => /^application\/x-www-form-urlencoded\b/i.test(type));
    const chosen = json ?? form;
    if (!chosen) return { skip: `its request body is ${types.join(' or ')}; only JSON and form bodies are sent` };
    bodyType = json ? 'json' : 'form';
    const media = body.content[chosen];
    const schema = schemaOf(doc, isRecord(media) ? media.schema : undefined, 'readOnly');
    const fields = isRecord(schema.properties) ? schema.properties : undefined;
    const flat =
      fields &&
      (schema.type === 'object' || schema.type === undefined) &&
      !schema.allOf &&
      !schema.anyOf &&
      !schema.oneOf &&
      Object.keys(fields).every((field) => !(field in properties));
    if (flat) {
      // The body's fields become the tool's own parameters, as a model writes them most readily.
      const fieldsRequired = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
      for (const [field, fieldSchema] of Object.entries(fields)) {
        properties[field] = fieldSchema;
        if (body.required === true && fieldsRequired.has(field)) required.push(field);
        placements.push({ arg: field, name: field, in: 'body-field' });
      }
    } else {
      const arg = 'body' in properties ? 'requestBody' : 'body';
      properties[arg] = {
        ...schema,
        ...(typeof body.description === 'string' && !schema.description ? { description: body.description } : {}),
      };
      if (body.required === true) required.push(arg);
      placements.push({ arg, name: arg, in: 'body' });
    }
  }

  // What it returns: its first success response's JSON.
  let result: Record<string, unknown> | undefined;
  const responses = isRecord(raw.responses) ? raw.responses : {};
  const success = Object.keys(responses)
    .filter((code) => /^2(?:\d\d|XX)$/i.test(code))
    .sort()[0];
  if (success) {
    const response = deref(doc, responses[success]);
    const content = isRecord(response) && isRecord(response.content) ? response.content : undefined;
    const json = content && Object.keys(content).find((type) => /json/i.test(type));
    const media = json && content ? content[json] : undefined;
    if (isRecord(media) && media.schema !== undefined) result = schemaOf(doc, media.schema, 'writeOnly');
    else if (!content) result = { type: 'null' };
  }
  return {
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    placements,
    ...(bodyType ? { bodyType } : {}),
    ...(result ? { result } : {}),
  };
}

function describe(raw: Record<string, unknown>, operation: OpenApiOperation): string {
  const text = [raw.summary, raw.description].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  const said = text.length ? text.join('\n\n') : `${operation.method} ${operation.path}`;
  return said.length > 1_024 ? `${said.slice(0, 1_021)}...` : said;
}

// ── Calling the API ─────────────────────────────────────────────────

function caller(
  operation: OpenApiOperation,
  placements: readonly Placement[],
  bodyType: 'json' | 'form' | undefined,
  baseUrl: string,
  options: OpenApiToolsOptions,
): NonNullable<ToolDefinition['execute']> {
  const base = new URL(`${baseUrl}/`);
  return async (args, context) => {
    // A call stopped before it starts sends nothing.
    context?.signal?.throwIfAborted();
    let path = operation.path;
    for (const placement of placements.filter((item) => item.in === 'path')) {
      const value = args[placement.arg];
      if (value === undefined || value === null || String(value) === '') {
        throw new OpenApiError(`${operation.name} needs "${placement.arg}"`, 'OPENAPI_INVALID');
      }
      const text = String(value);
      // A segment of only dots would move the path up, out of the operation.
      if (text === '.' || text === '..') {
        throw new OpenApiError(`"${placement.arg}" cannot be "${text}"`, 'OPENAPI_INVALID');
      }
      path = path.split(`{${placement.name}}`).join(encodeURIComponent(text));
    }
    const url = new URL(path.replace(/^\/+/, ''), base);
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: Record<string, unknown> | unknown;
    for (const placement of placements) {
      const value = args[placement.arg];
      if (value === undefined || value === null) continue;
      if (placement.in === 'query') {
        for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(placement.name, text(item));
      } else if (placement.in === 'header') headers[placement.name.toLowerCase()] = text(value);
      else if (placement.in === 'body-field') {
        body ??= {};
        (body as Record<string, unknown>)[placement.name] = value;
      } else if (placement.in === 'body') body = value;
    }
    const own = typeof options.headers === 'function' ? await options.headers({ operation, context }) : options.headers;
    for (const [name, value] of Object.entries(own ?? {})) headers[name.toLowerCase()] = value;
    let payload: string | undefined;
    if (body !== undefined && bodyType === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(
        Object.entries(body as Record<string, unknown>).map(([key, value]): [string, string] => [key, text(value)]),
      ).toString();
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const linked = linkSignals([context?.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url.href, {
        method: operation.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        redirect: 'manual',
        signal: linked.signal,
      });
      const answer = await readCapped(response, options.maxResponseBytes ?? 1_000_000, operation);
      if (response.status >= 300 && response.status < 400) {
        throw new OpenApiError(
          `${operation.name} was redirected to ${response.headers.get('location') ?? 'another place'}, which is not followed`,
          'OPENAPI_REQUEST',
          response.status,
        );
      }
      if (!response.ok) {
        throw new OpenApiError(
          `${operation.name} answered ${response.status}: ${detailOf(answer)}`,
          'OPENAPI_REQUEST',
          response.status,
        );
      }
      if (answer.trim() === '') return null;
      if (/json/i.test(response.headers.get('content-type') ?? '')) {
        try {
          return JSON.parse(answer);
        } catch {
          throw new OpenApiError(
            `${operation.name} answered with JSON that does not parse`,
            'OPENAPI_REQUEST',
            response.status,
          );
        }
      }
      return answer;
    } catch (error) {
      if (error instanceof OpenApiError || context?.signal?.aborted) throw error;
      throw new OpenApiError(
        `${operation.name} could not be reached: ${linked.signal.aborted ? `no answer within ${options.timeoutMs ?? 30_000} ms` : messageOf(error)}`,
        'OPENAPI_REQUEST',
      );
    } finally {
      linked.dispose();
    }
  };
}

/** The answer's text, refused past `limit` bytes rather than read whole. */
async function readCapped(response: Response, limit: number, operation: OpenApiOperation): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new OpenApiError(`${operation.name} answered more than ${limit} bytes`, 'OPENAPI_REQUEST', response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The API's own word for a failure: its error, message, detail, or title, or the start of its answer. */
function detailOf(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (isRecord(parsed)) {
      for (const key of ['error', 'message', 'detail', 'title']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) return value;
        if (isRecord(value) && typeof value.message === 'string') return value.message;
      }
    }
  } catch {
    // Not JSON: its text says it.
  }
  return answer.trim().slice(0, 300) || 'no detail';
}

// ── Helpers ─────────────────────────────────────────────────────────

function sanitize(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function uniqueName(name: string, used: Set<string>): string {
  const base = name.slice(0, 64);
  let candidate = base;
  for (let index = 2; used.has(candidate); index += 1) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function text(value: unknown): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
