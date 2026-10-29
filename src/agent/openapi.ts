/**
 * Tools read from a service's own API description, an OpenAPI document: one tool per operation, its
 * name, description, and parameters the service's, the capabilities it declares read from its method,
 * and what it returns kept as a schema. Given where the API lives, each tool calls it; without, the
 * tools describe the API and run nowhere, as `emulatedTools()` wants them.
 */
import type { ToolContext, ToolDefinition } from '../types/messages.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
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
  /**
   * The security it asks for, as the document writes it: alternatives, any one of which will do, each
   * the schemes it needs at once with their scopes. Empty when it asks for none.
   */
  security: Array<Record<string, string[]>>;
}

/**
 * A credential for one of the API's security schemes: the API key, bearer token, or access token as
 * text or `{ token }`; `{ username, password }` for HTTP basic; or `{ clientId, clientSecret }` for an
 * OAuth 2.0 client-credentials flow, whose token is fetched and kept until it expires.
 */
export type OpenApiCredential =
  | string
  | { token: string }
  | { username: string; password: string }
  | { clientId: string; clientSecret: string };

/** A request or callback the API sends to the application, which no tool calls: its name and the body it carries. */
export interface OpenApiWebhook {
  /** The webhook's name, or the operation and callback it belongs to. */
  name: string;
  /** `webhook` for one of the document's webhooks, `callback` for an operation's callback. */
  source: 'webhook' | 'callback';
  /** The HTTP method it arrives with, in capitals. */
  method: string;
  /** For a callback, the expression that names where it is sent, such as `{$request.body#/callbackUrl}`. */
  expression?: string;
  /** The JSON Schema of the body it carries, when it carries JSON. */
  body?: Record<string, unknown>;
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
  /**
   * Credentials for the API's own security schemes, by the name the document gives each, or a
   * function choosing one per call, such as by its tenant. Each call sends those its operation asks
   * for: the first of its alternatives every scheme of which has a credential, as an API key in its
   * header, query, or cookie, HTTP basic or bearer, or an OAuth 2.0 or OpenID Connect token. With
   * credentials given, a call whose operation asks for schemes none of which has one fails before it
   * is sent. They win over `headers`.
   */
  credentials?: Readonly<
    Record<
      string,
      OpenApiCredential | ((request: OpenApiHeadersRequest) => OpenApiCredential | Promise<OpenApiCredential>)
    >
  >;
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
  /** What the API sends the application, which no tool calls: its webhooks and its operations' callbacks. */
  webhooks: OpenApiWebhook[];
}

/** Why an API could not be read into tools, or a call to it failed. */
export class OpenApiError extends Error {
  constructor(
    message: string,
    /**
     * `OPENAPI_INVALID` for a malformed document or call, `OPENAPI_UNSUPPORTED` for one these tools
     * cannot read, such as Swagger 1.2 or a reference outside the document not bundled first, and
     * `OPENAPI_REQUEST` for a call the API refused or did not answer.
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
  /** A file, for a multipart body's field: base64, with its name and type. */
  file?: boolean;
}

/** How a body is sent: as JSON, a form, a multipart form, text, or bytes, with its media type. */
type BodyType = 'json' | 'form' | 'multipart' | 'text' | 'binary';

/** A file a model passes: base64 text, with the name and type it is sent under. */
const FILE_SCHEMA = {
  type: 'object',
  description: 'A file, its bytes as base64',
  properties: {
    base64: { type: 'string', description: 'The bytes, base64-encoded' },
    filename: { type: 'string' },
    mimeType: { type: 'string' },
  },
  required: ['base64'],
};

/**
 * Reads an OpenAPI 3 document into tools, one per operation: named by its `operationId`, or its
 * method and path; described by its summary; its path, query, and header parameters, and the fields
 * of a JSON body, as the tool's parameters. Each declares `api.read`, `api.write`, or
 * `api.destructive` with the API's name and its own, as its method says, and `network` for the
 * API's host when it runs. References within the document are followed; one outside it is refused
 * here, and followed by `loadOpenApiTools()` or `bundleOpenApiDocument()`. A Swagger 2.0 document is
 * read as the OpenAPI 3 document it describes. Each call sends the credentials its operation's
 * security asks for, from `credentials`.
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
  const used = new Set<string>();
  const schemes = isRecord(doc.components?.securitySchemes)
    ? (doc.components.securitySchemes as Record<string, unknown>)
    : {};
  const tokens = new Map<string, { token: string; until: number }>();

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
        security: securityOf(raw.security ?? doc.security),
      };
      if (options.include && !options.include(operation)) {
        used.delete(name);
        continue;
      }
      const built = buildOperation(doc, pathItem, raw);
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
        ...(baseUrl
          ? {
              execute: caller(operation, built.placements, built.body, baseUrl, options, (headers, url, context) =>
                authorize(operation, schemes, options, context, headers, url, baseUrl, tokens),
              ),
            }
          : {}),
      });
    }
  }
  return {
    name: apiName,
    ...(baseUrl ? { baseUrl } : {}),
    tools,
    operations,
    results,
    webhooks: webhooksOf(doc),
  };
}

/**
 * Fetches an OpenAPI document, as JSON, and reads it into tools, resolving its servers against where
 * it came from, and following its references to other documents on the same origin, or as
 * `references` allows.
 */
export async function loadOpenApiTools(
  url: string,
  options: OpenApiToolsOptions & Pick<OpenApiBundleOptions, 'references' | 'maxDocuments' | 'maxBytes'> = {},
): Promise<OpenApiTools> {
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
  const doc = parseDocument(
    await readCapped(response, options.maxBytes ?? 5_000_000, `The OpenAPI document at ${url}`),
  );
  const bundled = hasOutsideRef(doc) ? await bundleOpenApiDocument(doc, { ...options, documentUrl: url }) : doc;
  return openApiTools(bundled, { documentUrl: url, ...options });
}

/** Whether a document names anything outside itself. */
function hasOutsideRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOutsideRef);
  if (!isRecord(value)) return false;
  if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) return true;
  return Object.values(value).some(hasOutsideRef);
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
  if (doc.swagger === '2.0') return swaggerToOpenApi(doc);
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
      `${ref} is outside the document: read it with loadOpenApiTools(), or bundleOpenApiDocument() first`,
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

/** An operation's parameters, where each argument goes, and what it returns. */
function buildOperation(
  doc: OpenApiDocument,
  pathItem: Record<string, unknown>,
  raw: Record<string, unknown>,
): {
  parameters: Record<string, unknown>;
  placements: Placement[];
  body?: { type: BodyType; mediaType: string };
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

  let bodyOf: { type: BodyType; mediaType: string } | undefined;
  const body = deref(doc, raw.requestBody);
  if (isRecord(body) && isRecord(body.content) && Object.keys(body.content).length) {
    const types = Object.keys(body.content);
    const find = (pattern: RegExp) => types.find((type) => pattern.test(type));
    // JSON first, then a form, a multipart form, text, and anything else as bytes.
    const chosen = (
      [
        ['json', find(/^application\/(?:[\w.+-]+\+)?json\b/i)],
        ['form', find(/^application\/x-www-form-urlencoded\b/i)],
        ['multipart', find(/^multipart\/form-data\b/i)],
        ['text', find(/^text\/|^application\/(?:[\w.+-]+\+)?xml\b/i)],
      ] as Array<[BodyType, string | undefined]>
    ).find((candidate) => candidate[1] !== undefined) ?? ['binary', types[0]];
    bodyOf = { type: chosen[0], mediaType: chosen[1] as string };
    const media = body.content[bodyOf.mediaType];
    const schema = schemaOf(doc, isRecord(media) ? media.schema : undefined, 'readOnly');
    const fields = isRecord(schema.properties) ? schema.properties : undefined;
    const fielded = bodyOf.type === 'json' || bodyOf.type === 'form' || bodyOf.type === 'multipart';
    const flat =
      fielded &&
      fields &&
      (schema.type === 'object' || schema.type === undefined) &&
      !schema.allOf &&
      !schema.anyOf &&
      !schema.oneOf &&
      Object.keys(fields).every((field) => !(field in properties));
    if (flat && fields) {
      // The body's fields become the tool's own parameters, as a model writes them most readily.
      const fieldsRequired = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
      for (const [field, fieldSchema] of Object.entries(fields)) {
        const file = bodyOf.type === 'multipart' && isFile(fieldSchema);
        properties[field] = file
          ? {
              ...FILE_SCHEMA,
              ...(isRecord(fieldSchema) && typeof fieldSchema.description === 'string'
                ? { description: fieldSchema.description }
                : {}),
            }
          : fieldSchema;
        if (body.required === true && fieldsRequired.has(field)) required.push(field);
        placements.push({ arg: field, name: field, in: 'body-field', ...(file ? { file: true } : {}) });
      }
    } else {
      const arg = 'body' in properties ? 'requestBody' : 'body';
      const shape =
        bodyOf.type === 'binary'
          ? FILE_SCHEMA
          : bodyOf.type === 'text'
            ? { type: 'string', ...(typeof schema.description === 'string' ? { description: schema.description } : {}) }
            : schema;
      properties[arg] = {
        ...shape,
        ...(typeof body.description === 'string' && !shape.description ? { description: body.description } : {}),
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
    ...(bodyOf ? { body: bodyOf } : {}),
    ...(result ? { result } : {}),
  };
}

/**
 * Whether a form field is a file's bytes: binary, as OpenAPI 3.0 writes one, or of a media type and no
 * encoding, as 3.1 does. A field the API takes as base64 text is text.
 */
function isFile(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  return (
    schema.format === 'binary' || (typeof schema.contentMediaType === 'string' && schema.contentEncoding === undefined)
  );
}

/** An operation's security, or the document's, as alternatives of the schemes each needs. */
function securityOf(value: unknown): Array<Record<string, string[]>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((alternative) =>
      Object.fromEntries(
        Object.entries(alternative).map(([name, scopes]) => [name, Array.isArray(scopes) ? scopes.map(String) : []]),
      ),
    );
}

/** What the API sends the application: the document's webhooks, and each operation's callbacks. */
function webhooksOf(doc: OpenApiDocument): OpenApiWebhook[] {
  const found: OpenApiWebhook[] = [];
  const bodyOf = (operation: Record<string, unknown>) => {
    const body = deref(doc, operation.requestBody);
    const content = isRecord(body) && isRecord(body.content) ? body.content : undefined;
    const json = content && Object.keys(content).find((type) => /json/i.test(type));
    const media = json && content ? content[json] : undefined;
    return isRecord(media) && media.schema !== undefined ? schemaOf(doc, media.schema, 'readOnly') : undefined;
  };
  const add = (name: string, source: OpenApiWebhook['source'], item: unknown, expression?: string) => {
    const pathItem = deref(doc, item);
    if (!isRecord(pathItem)) return;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const body = bodyOf(operation);
      found.push({
        name,
        source,
        method: method.toUpperCase(),
        ...(expression ? { expression } : {}),
        ...(body ? { body } : {}),
      });
    }
  };
  for (const [name, item] of Object.entries(isRecord(doc.webhooks) ? doc.webhooks : {})) add(name, 'webhook', item);
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const pathItem = deref(doc, item);
    if (!isRecord(pathItem)) continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation) || !isRecord(operation.callbacks)) continue;
      const owner = typeof operation.operationId === 'string' ? operation.operationId : `${method}_${path}`;
      for (const [callback, raw] of Object.entries(operation.callbacks)) {
        const expressions = deref(doc, raw);
        if (!isRecord(expressions)) continue;
        for (const [expression, callbackItem] of Object.entries(expressions))
          add(`${owner}.${callback}`, 'callback', callbackItem, expression);
      }
    }
  }
  return found;
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
  bodyOf: { type: BodyType; mediaType: string } | undefined,
  baseUrl: string,
  options: OpenApiToolsOptions,
  authorizing: (headers: Record<string, string>, url: URL, context: ToolContext | undefined) => Promise<void>,
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
    await authorizing(headers, url, context);
    let payload: string | Uint8Array | FormData | undefined;
    const type = bodyOf?.type ?? 'json';
    if (body !== undefined && type === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(
        Object.entries(body as Record<string, unknown>).map(([key, value]): [string, string] => [key, text(value)]),
      ).toString();
    } else if (body !== undefined && type === 'multipart') {
      // The boundary is the platform's to write, with the content type it goes in.
      const form = new FormData();
      const files = new Set(placements.filter((item) => item.file).map((item) => item.name));
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (files.has(key)) {
          const file = fileOf(value, `${operation.name}'s "${key}"`);
          form.append(
            key,
            new Blob([file.bytes], { type: file.mimeType ?? 'application/octet-stream' }),
            file.filename ?? key,
          );
        } else form.append(key, text(value));
      }
      payload = form;
    } else if (body !== undefined && type === 'text') {
      headers['content-type'] = bodyOf?.mediaType ?? 'text/plain';
      payload = text(body);
    } else if (body !== undefined && type === 'binary') {
      const file = fileOf(body, `${operation.name}'s body`);
      headers['content-type'] =
        file.mimeType ??
        (bodyOf?.mediaType.includes('*')
          ? 'application/octet-stream'
          : (bodyOf?.mediaType ?? 'application/octet-stream'));
      payload = file.bytes;
    } else if (body !== undefined) {
      headers['content-type'] = bodyOf?.mediaType ?? 'application/json';
      payload = JSON.stringify(body);
    }

    const linked = linkSignals([context?.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url.href, {
        method: operation.method,
        headers,
        ...(payload !== undefined ? { body: payload as RequestInit['body'] } : {}),
        redirect: 'manual',
        signal: linked.signal,
      });
      const answer = await readCapped(response, options.maxResponseBytes ?? 1_000_000, operation.name);
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

/** A file a model passed, base64 text alone or with its name and type, as bytes. */
function fileOf(value: unknown, what: string): { bytes: Uint8Array; filename?: string; mimeType?: string } {
  const given = typeof value === 'string' ? { base64: value } : isRecord(value) ? value : {};
  if (typeof given.base64 !== 'string') throw new OpenApiError(`${what} is a file: give its base64`, 'OPENAPI_INVALID');
  if (!/^[A-Za-z0-9+/=\s]*$/.test(given.base64)) throw new OpenApiError(`${what} is not base64`, 'OPENAPI_INVALID');
  return {
    bytes: decodeBase64(given.base64),
    ...(typeof given.filename === 'string' ? { filename: given.filename } : {}),
    ...(typeof given.mimeType === 'string' ? { mimeType: given.mimeType } : {}),
  };
}

/**
 * Adds the credentials an operation's security asks for: the first alternative every scheme of which
 * has one. Without `credentials` given, nothing is added, as before; with them, an operation none of
 * whose alternatives can be met fails before it is sent.
 */
async function authorize(
  operation: OpenApiOperation,
  schemes: Record<string, unknown>,
  options: OpenApiToolsOptions,
  context: ToolContext | undefined,
  headers: Record<string, string>,
  url: URL,
  baseUrl: string,
  tokens: Map<string, { token: string; until: number }>,
): Promise<void> {
  const credentials = options.credentials;
  if (!credentials || operation.security.length === 0) return;
  const has = (name: string) => Object.hasOwn(credentials, name) && isRecord(schemes[name]);
  const chosen = operation.security.find((alternative) => Object.keys(alternative).every(has));
  if (!chosen) {
    const asked = operation.security.map((alternative) => Object.keys(alternative).join(' and ')).join(', or ');
    throw new OpenApiError(`${operation.name} needs credentials for ${asked}`, 'OPENAPI_INVALID');
  }
  for (const [name, scopes] of Object.entries(chosen)) {
    const scheme = schemes[name] as Record<string, unknown>;
    const given = credentials[name] as
      | OpenApiCredential
      | ((request: OpenApiHeadersRequest) => OpenApiCredential | Promise<OpenApiCredential>);
    const credential = typeof given === 'function' ? await given({ operation, context }) : given;
    // The credential's fields, whichever kind it is, read as the scheme needs them.
    const fields = (isRecord(credential) ? credential : {}) as Record<string, unknown>;
    const token = () => {
      if (typeof credential === 'string') return credential;
      if (typeof fields.token === 'string') return fields.token;
      throw new OpenApiError(`The credential for ${name} is a token, as text or { token }`, 'OPENAPI_INVALID');
    };
    if (scheme.type === 'apiKey') {
      const key = String(scheme.name ?? '');
      if (scheme.in === 'query') url.searchParams.set(key, token());
      else if (scheme.in === 'cookie') {
        const cookie = `${key}=${encodeURIComponent(token())}`;
        headers.cookie = headers.cookie ? `${headers.cookie}; ${cookie}` : cookie;
      } else headers[key.toLowerCase()] = token();
    } else if (scheme.type === 'http') {
      const kind = String(scheme.scheme ?? 'bearer').toLowerCase();
      if (kind === 'basic') {
        if (typeof fields.username !== 'string' || typeof fields.password !== 'string') {
          throw new OpenApiError(`The credential for ${name} is { username, password }`, 'OPENAPI_INVALID');
        }
        headers.authorization = `Basic ${encodeBase64(new TextEncoder().encode(`${fields.username}:${fields.password}`))}`;
      } else headers.authorization = `${kind === 'bearer' ? 'Bearer' : String(scheme.scheme)} ${token()}`;
    } else if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
      const client =
        typeof fields.clientId === 'string' && typeof fields.clientSecret === 'string'
          ? { clientId: fields.clientId, clientSecret: fields.clientSecret }
          : undefined;
      headers.authorization = `Bearer ${client ? await clientCredentials(name, scheme, client, scopes, baseUrl, options, tokens) : token()}`;
    } else {
      throw new OpenApiError(`${name} is ${String(scheme.type)}, which the tools do not send`, 'OPENAPI_UNSUPPORTED');
    }
  }
}

/** An OAuth 2.0 client-credentials token for the scopes, fetched from the scheme's token URL and kept until shortly before it expires. */
async function clientCredentials(
  name: string,
  scheme: Record<string, unknown>,
  client: { clientId: string; clientSecret: string },
  scopes: readonly string[],
  baseUrl: string,
  options: OpenApiToolsOptions,
  tokens: Map<string, { token: string; until: number }>,
): Promise<string> {
  const flow =
    isRecord(scheme.flows) && isRecord(scheme.flows.clientCredentials) ? scheme.flows.clientCredentials : undefined;
  if (!flow || typeof flow.tokenUrl !== 'string') {
    throw new OpenApiError(`${name} has no client-credentials flow to fetch a token from`, 'OPENAPI_UNSUPPORTED');
  }
  const key = `${name}\u0000${client.clientId}\u0000${[...scopes].sort().join(' ')}`;
  const kept = tokens.get(key);
  if (kept && kept.until > Date.now()) return kept.token;
  const response = await (options.fetch ?? globalThis.fetch)(new URL(flow.tokenUrl, `${baseUrl}/`).href, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: `Basic ${encodeBase64(new TextEncoder().encode(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`))}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const answer = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  };
  if (typeof answer.access_token !== 'string') {
    throw new OpenApiError(
      `${name}'s token URL answered ${response.status}: ${String(answer.error ?? 'no token')}`,
      'OPENAPI_REQUEST',
      response.status,
    );
  }
  const lifetime = typeof answer.expires_in === 'number' ? answer.expires_in * 1_000 : 3_600_000;
  // Kept until a minute before it expires, so a call never goes out with a token about to lapse.
  tokens.set(key, { token: answer.access_token, until: Date.now() + Math.max(0, lifetime - 60_000) });
  return answer.access_token;
}

/** The answer's text, refused past `limit` bytes rather than read whole; `what` is who answered. */
async function readCapped(response: Response, limit: number, what: string): Promise<string> {
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
      throw new OpenApiError(`${what} answered more than ${limit} bytes`, 'OPENAPI_REQUEST', response.status);
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

// ── Swagger 2.0 ─────────────────────────────────────────────────────

/**
 * A Swagger 2.0 document as the OpenAPI 3.0 document it describes: its host, base path, and schemes
 * as a server; its definitions, parameters, responses, and security definitions as components; a
 * body parameter, and form data, as a request body of what it consumes; and each response's schema as
 * content of what it produces. Every reference is moved with what it names.
 */
export function swaggerToOpenApi(swagger: Record<string, unknown>): OpenApiDocument {
  if (swagger.swagger !== '2.0') {
    throw new OpenApiError(`Swagger ${String(swagger.swagger)} is not 2.0`, 'OPENAPI_UNSUPPORTED');
  }
  const moved = renameRefs(swagger) as Record<string, unknown>;
  const consumes = stringList(moved.consumes) ?? ['application/json'];
  const produces = stringList(moved.produces) ?? ['application/json'];
  const schemes = stringList(moved.schemes) ?? ['https'];
  const host = typeof moved.host === 'string' ? moved.host : undefined;
  const basePath = typeof moved.basePath === 'string' ? moved.basePath : '';
  const components: Record<string, unknown> = {};
  if (isRecord(moved.definitions)) components.schemas = moved.definitions;
  if (isRecord(moved.parameters)) {
    // A shared body or form parameter has no OpenAPI 3 counterpart outside an operation; it is read where used.
    components.parameters = Object.fromEntries(
      Object.entries(moved.parameters).map(([name, parameter]) => [
        name,
        isRecord(parameter) ? parameterOf(parameter) : parameter,
      ]),
    );
  }
  if (isRecord(moved.responses)) {
    components.responses = Object.fromEntries(
      Object.entries(moved.responses).map(([name, response]) => [name, responseOf(response, produces)]),
    );
  }
  if (isRecord(moved.securityDefinitions)) {
    components.securitySchemes = Object.fromEntries(
      Object.entries(moved.securityDefinitions).map(([name, scheme]) => [name, securitySchemeOf(scheme)]),
    );
  }
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(isRecord(moved.paths) ? moved.paths : {})) {
    if (!isRecord(item)) continue;
    const converted: Record<string, unknown> = {};
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const [key, value] of Object.entries(item)) {
      if (key === 'parameters') {
        converted.parameters = shared.filter((parameter) => !isBodyLike(moved, parameter)).map(parameterOf);
        continue;
      }
      if (!METHODS.includes(key as (typeof METHODS)[number]) || !isRecord(value)) {
        converted[key] = value;
        continue;
      }
      converted[key] = operationOf(
        moved,
        value,
        shared,
        stringList(value.consumes) ?? consumes,
        stringList(value.produces) ?? produces,
      );
    }
    paths[path] = converted;
  }
  const {
    swagger: _swagger,
    host: _host,
    basePath: _basePath,
    schemes: _schemes,
    consumes: _consumes,
    produces: _produces,
    definitions: _definitions,
    parameters: _parameters,
    responses: _responses,
    securityDefinitions: _security,
    paths: _paths,
    ...rest
  } = moved;
  return {
    ...rest,
    openapi: '3.0.3',
    ...(host
      ? { servers: [{ url: `${schemes[0]}://${host}${basePath}` }] }
      : basePath
        ? { servers: [{ url: basePath }] }
        : {}),
    paths,
    ...(Object.keys(components).length ? { components } : {}),
  } as OpenApiDocument;
}

/** Every Swagger reference to definitions, parameters, or responses, pointed where OpenAPI 3 keeps them. */
function renameRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameRefs);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      key === '$ref' && typeof item === 'string'
        ? item
            .replace(/^#\/definitions\//, '#/components/schemas/')
            .replace(/^#\/parameters\//, '#/components/parameters/')
            .replace(/^#\/responses\//, '#/components/responses/')
        : renameRefs(item);
  }
  return out;
}

/** Whether a Swagger parameter, or the shared one it refers to, is a body or form field. */
function isBodyLike(doc: Record<string, unknown>, parameter: unknown): boolean {
  const found = swaggerParameter(doc, parameter);
  return found !== undefined && (found.in === 'body' || found.in === 'formData');
}

/** A Swagger parameter, its reference followed into the converted document's shared parameters. */
function swaggerParameter(doc: Record<string, unknown>, parameter: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parameter)) return undefined;
  if (typeof parameter.$ref !== 'string') return parameter;
  const name = parameter.$ref.replace(/^#\/components\/parameters\//, '');
  const shared = isRecord(doc.parameters) ? doc.parameters[name] : undefined;
  return isRecord(shared) ? shared : undefined;
}

/** A Swagger path, query, or header parameter as OpenAPI 3's: its type and the like as a schema. */
function parameterOf(parameter: unknown): unknown {
  if (
    !isRecord(parameter) ||
    typeof parameter.$ref === 'string' ||
    parameter.in === 'body' ||
    parameter.in === 'formData'
  ) {
    return parameter;
  }
  const { name, in: place, description, required, ...schema } = parameter;
  const { collectionFormat: _format, allowEmptyValue: _empty, ...kept } = schema;
  return {
    name,
    in: place,
    ...(description !== undefined ? { description } : {}),
    ...(required !== undefined ? { required } : {}),
    schema: kept,
  };
}

/** A Swagger response as OpenAPI 3's: its schema as content of the first type the API produces. */
function responseOf(response: unknown, produces: readonly string[]): unknown {
  if (!isRecord(response) || typeof response.$ref === 'string') return response;
  const { schema, examples: _examples, ...rest } = response;
  return {
    ...rest,
    description: typeof rest.description === 'string' ? rest.description : '',
    ...(schema !== undefined ? { content: { [produces[0] ?? 'application/json']: { schema } } } : {}),
  };
}

/** A Swagger security definition as OpenAPI 3's security scheme. */
function securitySchemeOf(scheme: unknown): unknown {
  if (!isRecord(scheme)) return scheme;
  if (scheme.type === 'basic')
    return { type: 'http', scheme: 'basic', ...(scheme.description ? { description: scheme.description } : {}) };
  if (scheme.type !== 'oauth2') return scheme;
  const flowName =
    { implicit: 'implicit', password: 'password', application: 'clientCredentials', accessCode: 'authorizationCode' }[
      String(scheme.flow)
    ] ?? 'clientCredentials';
  return {
    type: 'oauth2',
    ...(scheme.description ? { description: scheme.description } : {}),
    flows: {
      [flowName]: {
        ...(scheme.authorizationUrl ? { authorizationUrl: scheme.authorizationUrl } : {}),
        ...(scheme.tokenUrl ? { tokenUrl: scheme.tokenUrl } : {}),
        scopes: isRecord(scheme.scopes) ? scheme.scopes : {},
      },
    },
  };
}

/** A Swagger operation as OpenAPI 3's: its body or form fields as a request body, its responses as content. */
function operationOf(
  doc: Record<string, unknown>,
  operation: Record<string, unknown>,
  shared: readonly unknown[],
  consumes: readonly string[],
  produces: readonly string[],
): Record<string, unknown> {
  const own = Array.isArray(operation.parameters) ? operation.parameters : [];
  const all = [...shared, ...own].map((parameter) => swaggerParameter(doc, parameter) ?? parameter);
  const body = all.find((parameter) => isRecord(parameter) && parameter.in === 'body') as
    | Record<string, unknown>
    | undefined;
  const form = all.filter((parameter) => isRecord(parameter) && parameter.in === 'formData') as Record<
    string,
    unknown
  >[];
  const { parameters: _parameters, consumes: _consumes, produces: _produces, responses, ...rest } = operation;
  const out: Record<string, unknown> = {
    ...rest,
    ...(own.length ? { parameters: own.filter((parameter) => !isBodyLike(doc, parameter)).map(parameterOf) } : {}),
    responses: Object.fromEntries(
      Object.entries(isRecord(responses) ? responses : {}).map(([code, response]) => [
        code,
        responseOf(response, produces),
      ]),
    ),
  };
  if (body) {
    out.requestBody = {
      ...(body.description ? { description: body.description } : {}),
      ...(body.required !== undefined ? { required: body.required } : {}),
      content: {
        [consumes.find((type) => /json/i.test(type)) ?? consumes[0] ?? 'application/json']: {
          schema: body.schema ?? {},
        },
      },
    };
  } else if (form.length) {
    const files = form.some((field) => field.type === 'file');
    const type =
      files || consumes.some((item) => /multipart\/form-data/i.test(item))
        ? 'multipart/form-data'
        : 'application/x-www-form-urlencoded';
    const properties = Object.fromEntries(
      form.map((field) => {
        const { name: _name, in: _in, required: _required, collectionFormat: _format, ...schema } = field;
        return [String(field.name), field.type === 'file' ? { ...schema, type: 'string', format: 'binary' } : schema];
      }),
    );
    const required = form.filter((field) => field.required === true).map((field) => String(field.name));
    out.requestBody = {
      ...(required.length ? { required: true } : {}),
      content: { [type]: { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } },
    };
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length ? value.map(String) : undefined;
}

// ── References outside the document ──────────────────────────────────

/** Options for `bundleOpenApiDocument()`. */
export interface OpenApiBundleOptions {
  /** Where the document came from: references outside it are read relative to it. */
  documentUrl: string;
  /**
   * Which documents a reference may name: `same-origin`, the default, only those on the document's
   * own origin; `any`, any HTTP or HTTPS URL; or a function deciding each. A document never makes the
   * tools fetch where it was not allowed to.
   */
  references?: 'same-origin' | 'any' | ((url: string) => boolean);
  /** The most documents read, the first included. Defaults to 50. */
  maxDocuments?: number;
  /** The largest document read, the first included, in bytes. Defaults to 5 MB. */
  maxBytes?: number;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The document with every reference outside it read in its place: each other document fetched, as
 * JSON, relative to the one that names it, its own references followed the same way, and a reference
 * back to one still being read left as a description. `loadOpenApiTools()` does this before reading the
 * document into tools.
 */
export async function bundleOpenApiDocument(
  document: OpenApiDocument,
  options: OpenApiBundleOptions,
): Promise<OpenApiDocument> {
  const root = new URL(options.documentUrl);
  const allowed = (url: URL) =>
    options.references === 'any'
      ? url.protocol === 'https:' || url.protocol === 'http:'
      : typeof options.references === 'function'
        ? options.references(url.href)
        : url.origin === root.origin;
  const loaded = new Map<string, Promise<unknown>>([[stripHash(root), Promise.resolve(document)]]);
  const load = (url: URL): Promise<unknown> => {
    const key = stripHash(url);
    let found = loaded.get(key);
    if (!found) {
      if (!allowed(url)) {
        return Promise.reject(
          new OpenApiError(`${key} is not a document references may name here`, 'OPENAPI_UNSUPPORTED'),
        );
      }
      if (loaded.size >= (options.maxDocuments ?? 50)) {
        return Promise.reject(
          new OpenApiError(
            `The document refers to more than ${options.maxDocuments ?? 50} documents`,
            'OPENAPI_INVALID',
          ),
        );
      }
      found = fetchDocument(key, options);
      loaded.set(key, found);
    }
    return found;
  };
  /** A value with every reference outside its own document read in, `from` being where it is. */
  const inline = async (value: unknown, from: URL, trail: readonly string[]): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map((item) => inline(item, from, trail)));
    if (!isRecord(value)) return value;
    if (typeof value.$ref === 'string') {
      const target = new URL(value.$ref, from);
      // A reference within the root document stays one, for the tools to follow.
      if (stripHash(target) === stripHash(root)) {
        const { $ref: _ref, ...siblings } = value;
        return { $ref: target.hash || '#', ...(await inlineFields(siblings, from, trail)) };
      }
      if (trail.includes(target.href))
        return { description: `The same shape as ${target.hash.split('/').at(-1) || target.pathname}, nested` };
      const named = pointer(await load(target), target.hash, target.href);
      const { $ref: _ref, ...siblings } = value;
      return {
        ...((await inline(named, target, [...trail, target.href])) as Record<string, unknown>),
        ...(await inlineFields(siblings, from, trail)),
      };
    }
    return inlineFields(value, from, trail);
  };
  const inlineFields = async (value: Record<string, unknown>, from: URL, trail: readonly string[]) =>
    Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await inline(item, from, trail)])),
    );
  return (await inline(document, root, [])) as OpenApiDocument;
}

async function fetchDocument(url: string, options: OpenApiBundleOptions): Promise<unknown> {
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new OpenApiError(`${url} answered ${response.status}`, 'OPENAPI_REQUEST', response.status);
  const text = await readCapped(response, options.maxBytes ?? 5_000_000, url);
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenApiError(`${url} is not JSON; parse a YAML document first`, 'OPENAPI_INVALID');
  }
}

/** What a JSON pointer names in a document. */
function pointer(document: unknown, hash: string, where: string): unknown {
  let node = document;
  for (const part of hash.replace(/^#/, '').split('/').slice(1)) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    node = isRecord(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
    if (node === undefined) throw new OpenApiError(`${where} names nothing`, 'OPENAPI_INVALID');
  }
  return node;
}

function stripHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}
