import {
  createHashEmbeddings,
  type EmbeddingProvider,
  type VectorDocument,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
} from '../hallucination/retrieval.js';
import {
  assertDimensions,
  assertWidth,
  filterEntries,
  filterFields,
  META_PREFIX,
  parseMetadata,
  requestJson,
  stableUuid,
  vectorsFor,
} from './vector-helpers.js';

/** The type of a metadata field a Weaviate collection filters on. */
export type WeaviateFieldType = 'text' | 'number' | 'boolean';

/** Options for the Weaviate store. */
export interface WeaviateVectorStoreOptions {
  /** The Weaviate server, such as `http://localhost:8080` or a Weaviate Cloud cluster URL. */
  url: string;
  /** The collection (class) chunks are kept in. Must start with a capital letter. Defaults to `NexusChunk`. */
  collection?: string;
  /** Width of every vector. Must match the embedding function's output. */
  dimensions: number;
  /** Sent as a bearer token, for Weaviate Cloud or a server with API-key authentication. */
  apiKey?: string;
  /** Embeds chunks that arrive without a vector, and search queries. Defaults to hashed term vectors. */
  embed?: EmbeddingProvider;
  /** Replaces the global `fetch`, for a proxy, retries, or tests. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Aborts a request that takes longer, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** Raised when Weaviate answers with an error, or reports one for an object in a batch. */
export class WeaviateError extends Error {
  constructor(
    message: string,
    /** The HTTP status Weaviate answered with; 200 for an error inside a successful batch or query. */
    readonly status: number,
    /** Weaviate's response body, or the error it reported, as text. */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'WeaviateError';
  }
}

interface WeaviateHit {
  chunkId?: string;
  content?: string;
  source?: string | null;
  metadata?: string | null;
  _additional?: { distance?: number };
}

interface WeaviateSchema {
  properties?: Array<{ name: string; dataType?: string[] }>;
}

/**
 * Retrieval chunks in a Weaviate collection, through its REST and GraphQL APIs.
 *
 * No Weaviate client is a dependency. The collection brings its own vectors (no vectorizer) and uses
 * cosine distance; a result's score is one minus that distance. Object ids are stable UUIDs derived
 * from chunk ids, and the chunk id travels as the `chunkId` property. Top-level string, number, and
 * boolean metadata fields are copied under `meta_` properties for filtering; declare the ones you
 * filter on in `migrate()` so they are indexed with the right type. A filter is typed by the
 * collection's schema, read once when a filter first needs it: a value of another type than its
 * property matches nothing, as in every other store.
 */
export class WeaviateVectorStore implements VectorStore {
  private readonly base: string;
  private readonly collection: string;
  private readonly embed: EmbeddingProvider;
  /** Each property's data type, read from the schema the first time a filter needs it. */
  private dataTypes?: Promise<Map<string, string>>;

  constructor(private readonly options: WeaviateVectorStoreOptions) {
    assertDimensions(options.dimensions);
    this.collection = options.collection ?? 'NexusChunk';
    if (!/^[A-Z][_0-9A-Za-z]*$/.test(this.collection)) {
      throw new RangeError(
        'A Weaviate collection name starts with a capital letter and holds only letters, digits, and _',
      );
    }
    this.base = `${options.url.replace(/\/+$/, '')}/v1`;
    this.embed = options.embed ?? ((texts) => createHashEmbeddings(texts, options.dimensions));
  }

  /**
   * Creates the collection unless it exists, then adds a property for each metadata field you filter
   * on that it does not have yet. A list declares text fields; a map names each field's type. Never
   * runs implicitly.
   */
  async migrate(options: { filterFields?: readonly string[] | Record<string, WeaviateFieldType> } = {}): Promise<void> {
    const fields: Array<readonly [string, WeaviateFieldType]> = Array.isArray(options.filterFields)
      ? options.filterFields.map((field) => [field, 'text'] as const)
      : Object.entries((options.filterFields ?? {}) as Record<string, WeaviateFieldType>);
    const property = ([field, type]: readonly [string, WeaviateFieldType]) => {
      if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(field)) throw new RangeError(`"${field}" cannot be a Weaviate property`);
      return {
        name: `${META_PREFIX}${field}`,
        dataType: [type],
        ...(type === 'text' ? { tokenization: 'field' } : {}),
      };
    };
    const existing = (await this.request(
      'GET',
      `/schema/${this.collection}`,
      undefined,
      true,
    )) as WeaviateSchema | null;
    if (!existing) {
      await this.request('POST', '/schema', {
        class: this.collection,
        vectorizer: 'none',
        vectorIndexConfig: { distance: 'cosine' },
        properties: [
          { name: 'chunkId', dataType: ['text'], tokenization: 'field' },
          { name: 'content', dataType: ['text'] },
          { name: 'source', dataType: ['text'], tokenization: 'field' },
          { name: 'metadata', dataType: ['text'], indexFilterable: false, indexSearchable: false },
          ...fields.map(property),
        ],
      });
      return;
    }
    const names = new Set((existing.properties ?? []).map((item) => item.name));
    for (const field of fields) {
      if (!names.has(`${META_PREFIX}${field[0]}`)) {
        await this.request('POST', `/schema/${this.collection}/properties`, property(field));
      }
    }
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const vectors = await vectorsFor(documents, this.embed, this.options.dimensions);
    const objects = await Promise.all(
      documents.map(async (doc, index) => ({
        class: this.collection,
        id: await stableUuid(doc.id),
        vector: vectors[index],
        properties: {
          ...filterFields(doc.metadata),
          chunkId: doc.id,
          content: doc.content,
          source: doc.source ?? null,
          metadata: JSON.stringify(doc.metadata ?? null),
        },
      })),
    );
    const results = (await this.request('POST', '/batch/objects', { objects })) as Array<{
      result?: { errors?: { error?: Array<{ message?: string }> } };
    }>;
    const failed = results?.flatMap((item) => item.result?.errors?.error ?? []);
    if (failed?.length) {
      const detail = failed.map((error) => error.message).join('; ');
      throw new WeaviateError(`Weaviate refused ${failed.length} object(s): ${detail}`, 200, detail);
    }
  }

  /** The chunks most similar to a query, best first. */
  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const [vector] = await this.embed([query]);
    return this.searchVector(vector, options);
  }

  /** The chunks most similar to a vector, best first. */
  async searchVector(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    assertWidth(vector, this.options.dimensions);
    const where = await this.where(options.filter);
    if (where === undefined) return [];
    const query = `{ Get { ${this.collection}(nearVector: {vector: ${JSON.stringify(vector)}}, limit: ${options.topK || 5}${where}) { chunkId content source metadata _additional { distance } } } }`;
    const response = (await this.request('POST', '/graphql', { query })) as {
      data?: { Get?: Record<string, WeaviateHit[] | null> };
      errors?: Array<{ message?: string }>;
    };
    if (response.errors?.length) {
      const detail = response.errors.map((error) => error.message).join('; ');
      throw new WeaviateError(`Weaviate search failed: ${detail}`, 200, detail);
    }
    const minScore = options.minScore ?? 0;
    const results: VectorSearchResult[] = [];
    for (const hit of response.data?.Get?.[this.collection] ?? []) {
      const score = 1 - (hit._additional?.distance ?? 1);
      if (score < minScore) continue;
      const metadata = parseMetadata(hit.metadata);
      results.push({
        id: hit.chunkId ?? '',
        content: hit.content ?? '',
        ...(hit.source ? { source: hit.source } : {}),
        ...(metadata ? { metadata } : {}),
        score,
      });
    }
    return results;
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request('DELETE', '/batch/objects', {
      match: {
        class: this.collection,
        where: { path: ['chunkId'], operator: 'ContainsAny', valueTextArray: [...ids] },
      },
    });
  }

  /**
   * The GraphQL `where` argument for a filter, or `undefined` when a value can never match. Weaviate
   * refuses an operand of another type than the property's, where every other store finds nothing.
   */
  private async where(filter: VectorSearchOptions['filter']): Promise<string | undefined> {
    const entries = filterEntries(filter);
    if (entries.length === 0) return '';
    const types = await this.dataTypesOf(entries.map(([key]) => `${META_PREFIX}${key}`));
    const conditions: string[] = [];
    for (const [key, value] of entries) {
      const path = `${META_PREFIX}${key}`;
      const operand = operandFor(types.get(path), value);
      if (operand === null) return undefined;
      conditions.push(`{path: [${JSON.stringify(path)}], operator: Equal, ${operand}: ${JSON.stringify(value)}}`);
    }
    return `, where: ${conditions.length === 1 ? conditions[0] : `{operator: And, operands: [${conditions.join(', ')}]}`}`;
  }

  /** The data types of these properties, reading the schema again when one is not in the copy held. */
  private async dataTypesOf(names: readonly string[]): Promise<Map<string, string>> {
    this.dataTypes ??= this.readDataTypes();
    const held = await this.dataTypes;
    // A property added since the schema was read: by migrate(), another process, or auto-schema.
    if (names.every((name) => held.has(name))) return held;
    this.dataTypes = this.readDataTypes();
    return this.dataTypes;
  }

  private readDataTypes(): Promise<Map<string, string>> {
    const read = (
      this.request('GET', `/schema/${this.collection}`, undefined, true) as Promise<WeaviateSchema | null>
    ).then(
      (schema) => new Map((schema?.properties ?? []).map((property) => [property.name, property.dataType?.[0] ?? ''])),
    );
    // A failed read is not kept, so the next search tries again.
    read.catch(() => {
      if (this.dataTypes === read) this.dataTypes = undefined;
    });
    return read;
  }

  private request(method: string, path: string, body?: unknown, allowNotFound = false): Promise<unknown> {
    return requestJson({
      fetch: this.options.fetch ?? globalThis.fetch,
      url: `${this.base}${path}`,
      method,
      headers: {
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...this.options.headers,
      },
      body,
      timeoutMs: this.options.timeoutMs ?? 30_000,
      ...(allowNotFound ? { notFound: null } : {}),
      error: (message, status, text) => new WeaviateError(`Weaviate ${message}`, status, text),
    });
  }
}

/**
 * The operand a filter value is compared with, chosen by its property's data type, or `null` when the
 * value cannot equal any value of that type. A type this store does not know, or a property the
 * schema lacks, is left for Weaviate to judge.
 */
function operandFor(dataType: string | undefined, value: string | number | boolean): string | null {
  switch (dataType?.replace(/\[\]$/, '')) {
    case 'text':
      return typeof value === 'string' ? 'valueText' : null;
    case 'number':
      return typeof value === 'number' ? 'valueNumber' : null;
    case 'int':
      return Number.isInteger(value) ? 'valueInt' : null;
    case 'boolean':
      return typeof value === 'boolean' ? 'valueBoolean' : null;
    default:
      return typeof value === 'string' ? 'valueText' : typeof value === 'number' ? 'valueNumber' : 'valueBoolean';
  }
}
