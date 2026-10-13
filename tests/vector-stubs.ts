/**
 * In-memory stand-ins for the parts of each vector database's API the stores use. Each models the
 * behaviour the contract depends on — upsert by id, cosine ranking, typed equality filters, deletes —
 * so the same contract test runs against every adapter without a server.
 */
import { cosineSimilarity, normalizeVector } from '../src/hallucination/retrieval.js';

type Json = Record<string, unknown>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const cosine = (a: number[], b: number[]) => cosineSimilarity(normalizeVector(a), normalizeVector(b));

/**
 * Redis with RediSearch: FT.CREATE, HSET, DEL, and KNN FT.SEARCH with tag filters.
 *
 * The client is shaped as ioredis's by default: `call()`, plus a `sendCommand()` that takes an ioredis
 * command object and fails on an array, as ioredis does. `'node-redis'` gives only `sendCommand()`,
 * taking an array. A search answers as the protocol does: RESP2's `[total, key, fields, ...]`, or
 * RESP3's map as a flat array (ioredis 6's default, and this stub's for ioredis), an object, or a `Map`.
 */
export function redisStub(
  options: { client?: 'ioredis' | 'node-redis'; reply?: 'resp2' | 'resp3' | 'resp3-object' | 'resp3-map' } = {},
) {
  const shape = options.client ?? 'ioredis';
  const protocol = options.reply ?? (shape === 'ioredis' ? 'resp3' : 'resp2');
  const hashes = new Map<string, Map<string, string | Buffer>>();
  const indexes = new Map<string, { prefix: string }>();
  const commands: string[] = [];
  const call = async (command: string, ...args: Array<string | Buffer>): Promise<unknown> => {
    commands.push(command);
    const text = args.map((arg) => (typeof arg === 'string' ? arg : ''));
    if (command === 'FT.CREATE') {
      if (indexes.has(text[0])) throw new Error('Index already exists');
      indexes.set(text[0], { prefix: text[text.indexOf('PREFIX') + 2] });
      return 'OK';
    }
    if (command === 'DEL') {
      for (const key of text) hashes.delete(key);
      return text.length;
    }
    if (command === 'HSET') {
      const hash = new Map<string, string | Buffer>();
      for (let index = 1; index + 1 < args.length; index += 2) hash.set(text[index], args[index + 1]);
      hashes.set(text[0], hash);
      return 1;
    }
    if (command === 'FT.SEARCH') {
      const index = indexes.get(text[0]);
      if (!index) throw new Error('no such index');
      const [, clauses, k] = /^(.*)=>\[KNN (\d+) @embedding \$vector AS distance\]$/.exec(text[1]) ?? [];
      const filters = [...(clauses ?? '').matchAll(/@(\w+):\{((?:\\.|[^}])*)\}/g)].map((match) => [
        match[1],
        match[2].replace(/\\(.)/g, '$1'),
      ]);
      const blob = args[text.indexOf('vector') + 1] as Buffer;
      const query = Array.from(new Float32Array(new Uint8Array(blob).slice().buffer));
      const hits = [...hashes.entries()]
        .filter(
          ([key, hash]) => key.startsWith(index.prefix) && filters.every(([field, value]) => hash.get(field) === value),
        )
        .map(([key, hash]) => {
          const stored = hash.get('embedding') as Buffer;
          const vector = Array.from(new Float32Array(new Uint8Array(stored).slice().buffer));
          return { key, hash, distance: 1 - cosine(query, vector) };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, Number(k))
        .map(({ key, hash, distance }) => ({
          key,
          fields: [
            ...['id', 'content', 'source', 'metadata'].flatMap((field) => [field, hash.get(field)]),
            'distance',
            String(distance),
          ],
        }));
      if (protocol === 'resp2') return [hits.length, ...hits.flatMap(({ key, fields }) => [key, fields])];
      // RESP3: a map, which a client hands over as a flat array, a plain object, or a Map.
      const map = (pairs: unknown[]): unknown => {
        if (protocol === 'resp3') return pairs;
        const entries: Array<[string, unknown]> = [];
        for (let index = 0; index + 1 < pairs.length; index += 2)
          entries.push([String(pairs[index]), pairs[index + 1]]);
        return protocol === 'resp3-map' ? new Map(entries) : Object.fromEntries(entries);
      };
      return map([
        'attributes',
        [],
        'format',
        'STRING',
        'results',
        hits.map(({ key, fields }) => map(['id', key, 'extra_attributes', map(fields), 'values', []])),
        'total_results',
        hits.length,
        'warning',
        [],
      ]);
    }
    throw new Error(`unknown command ${command}`);
  };
  const client =
    shape === 'node-redis'
      ? { sendCommand: (args: Array<string | Buffer>) => call(args[0] as string, ...args.slice(1)) }
      : {
          call,
          sendCommand: async (command: { setReplyContext?: unknown }) => {
            if (typeof command.setReplyContext !== 'function') {
              throw new TypeError('command.setReplyContext is not a function');
            }
            throw new Error('the stub does not take ioredis command objects');
          },
        };
  return { client, hashes, commands };
}

/** Pinecone's data plane: upsert, query with `$eq` and `$and` filters, and delete. */
export function pineconeStub() {
  const vectors = new Map<string, { values: number[]; metadata: Json }>();
  const headers: Array<Record<string, string>> = [];
  const matchesFilter = (metadata: Json, filter: Json | undefined): boolean => {
    if (!filter) return true;
    if (Array.isArray(filter.$and)) return (filter.$and as Json[]).every((part) => matchesFilter(metadata, part));
    return Object.entries(filter).every(([key, condition]) => metadata[key] === (condition as { $eq: unknown }).$eq);
  };
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    headers.push(init.headers as Record<string, string>);
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init.body)) as Json;
    if (path === '/vectors/upsert') {
      for (const vector of body.vectors as Array<{ id: string; values: number[]; metadata: Json }>) {
        vectors.set(vector.id, { values: vector.values, metadata: vector.metadata });
      }
      return json(200, { upsertedCount: (body.vectors as unknown[]).length });
    }
    if (path === '/query') {
      const matches = [...vectors.entries()]
        .filter(([, vector]) => matchesFilter(vector.metadata, body.filter as Json | undefined))
        .map(([id, vector]) => ({
          id,
          score: cosine(body.vector as number[], vector.values),
          metadata: vector.metadata,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, body.topK as number);
      return json(200, { matches, namespace: body.namespace ?? '' });
    }
    if (path === '/vectors/delete') {
      for (const id of body.ids as string[]) vectors.delete(id);
      return json(200, {});
    }
    return json(404, { message: 'not found' });
  };
  return { fetch: fetch as typeof globalThis.fetch, vectors, headers };
}

/** Chroma's v2 API: collections, upsert, query with typed `$eq` and `$and`, and delete. */
export function chromaStub() {
  const collections = new Map<
    string,
    { id: string; records: Map<string, { embedding: number[]; document: string; metadata: Json }> }
  >();
  const matchesWhere = (metadata: Json, where: Json | undefined): boolean => {
    if (!where) return true;
    if (Array.isArray(where.$and)) return (where.$and as Json[]).every((part) => matchesWhere(metadata, part));
    return Object.entries(where).every(([key, condition]) => metadata[key] === (condition as { $eq: unknown }).$eq);
  };
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : {};
    const base = '/api/v2/tenants/default_tenant/databases/default_database/collections';
    if (path === base && init.method === 'POST') {
      const name = body.name as string;
      if (!collections.has(name)) collections.set(name, { id: `id-${collections.size + 1}`, records: new Map() });
      return json(200, { id: collections.get(name)?.id, name });
    }
    const byName = path.startsWith(`${base}/`) ? collections.get(path.slice(base.length + 1)) : undefined;
    if (init.method === 'GET') return byName ? json(200, { id: byName.id }) : json(404, { error: 'NotFoundError' });
    const [, id, action] = /\/collections\/([^/]+)\/(\w+)$/.exec(path) ?? [];
    const collection = [...collections.values()].find((item) => item.id === id);
    if (!collection) return json(404, { error: 'NotFoundError' });
    if (action === 'upsert') {
      for (const [index, recordId] of (body.ids as string[]).entries()) {
        collection.records.set(recordId, {
          embedding: (body.embeddings as number[][])[index],
          document: (body.documents as string[])[index],
          metadata: (body.metadatas as Json[])[index],
        });
      }
      return json(200, {});
    }
    if (action === 'query') {
      const query = (body.query_embeddings as number[][])[0];
      const hits = [...collection.records.entries()]
        .filter(([, record]) => matchesWhere(record.metadata, body.where as Json | undefined))
        .map(([recordId, record]) => ({ recordId, record, distance: 1 - cosine(query, record.embedding) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, body.n_results as number);
      return json(200, {
        ids: [hits.map((hit) => hit.recordId)],
        documents: [hits.map((hit) => hit.record.document)],
        metadatas: [hits.map((hit) => hit.record.metadata)],
        distances: [hits.map((hit) => hit.distance)],
      });
    }
    if (action === 'delete') {
      for (const recordId of body.ids as string[]) collection.records.delete(recordId);
      return json(200, {});
    }
    return json(404, {});
  };
  return { fetch: fetch as typeof globalThis.fetch, collections };
}

/**
 * Weaviate's REST schema and batch APIs, and the GraphQL `Get` with `nearVector` and typed `Equal`
 * filters the store sends. Filters are checked as Weaviate checks them: an operand of another type than
 * the property's, or a property the class lacks, fails the whole query.
 */
export function weaviateStub() {
  const classes = new Map<
    string,
    {
      properties: Array<{ name: string; dataType?: string[] }>;
      objects: Map<string, { vector: number[]; properties: Json }>;
    }
  >();
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : {};
    const method = init.method ?? 'GET';
    const schema = /^\/v1\/schema\/(\w+)(\/properties)?$/.exec(path);
    if (schema && method === 'GET') {
      const found = classes.get(schema[1]);
      return found ? json(200, { class: schema[1], properties: found.properties }) : json(404, {});
    }
    if (schema?.[2] && method === 'POST') {
      classes.get(schema[1])?.properties.push(body as { name: string });
      return json(200, body);
    }
    if (path === '/v1/schema' && method === 'POST') {
      classes.set(body.class as string, { properties: body.properties as Array<{ name: string }>, objects: new Map() });
      return json(200, body);
    }
    if (path === '/v1/batch/objects' && method === 'POST') {
      const objects = body.objects as Array<{ class: string; id: string; vector: number[]; properties: Json }>;
      return json(
        200,
        objects.map((object) => {
          const target = classes.get(object.class);
          if (!target) return { result: { errors: { error: [{ message: `class ${object.class} not found` }] } } };
          target.objects.set(object.id, { vector: object.vector, properties: object.properties });
          return { id: object.id, result: {} };
        }),
      );
    }
    if (path === '/v1/batch/objects' && method === 'DELETE') {
      const match = body.match as { class: string; where: { valueTextArray: string[] } };
      const target = classes.get(match.class);
      for (const [id, object] of target?.objects ?? []) {
        if (match.where.valueTextArray.includes(object.properties.chunkId as string)) target?.objects.delete(id);
      }
      return json(200, { results: {} });
    }
    if (path === '/v1/graphql') {
      const query = body.query as string;
      const name = /Get \{ (\w+)\(/.exec(query)?.[1] ?? '';
      const target = classes.get(name);
      if (!target) return json(200, { errors: [{ message: `Cannot query field "${name}"` }] });
      const vector = JSON.parse(/nearVector: \{vector: (\[[^\]]*\])\}/.exec(query)?.[1] ?? '[]') as number[];
      const limit = Number(/limit: (\d+)/.exec(query)?.[1]);
      const conditions = [
        ...query.matchAll(
          /\{path: \["(\w+)"\], operator: Equal, (valueText|valueNumber|valueInt|valueBoolean): ([^}]+)\}/g,
        ),
      ].map(([, field, kind, raw]) => ({ field, kind, value: JSON.parse(raw) as unknown }));
      const operands: Record<string, string> = {
        text: 'valueText',
        number: 'valueNumber',
        int: 'valueInt',
        boolean: 'valueBoolean',
      };
      for (const { field, kind } of conditions) {
        const dataType = target.properties.find((property) => property.name === field)?.dataType?.[0];
        if (!dataType) {
          return json(200, { errors: [{ message: `no such prop with name '${field}' found in class '${name}'` }] });
        }
        if (operands[dataType] !== kind) {
          const message = `invalid 'where' filter: data type filter cannot use "${kind}" on type "${dataType}", use "${operands[dataType]}" instead`;
          return json(200, { errors: [{ message }] });
        }
      }
      const hits = [...target.objects.values()]
        .filter((object) => conditions.every(({ field, value }) => object.properties[field] === value))
        .map((object) => ({ object, distance: 1 - cosine(vector, object.vector) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map(({ object, distance }) => ({
          chunkId: object.properties.chunkId,
          content: object.properties.content,
          source: object.properties.source,
          metadata: object.properties.metadata,
          _additional: { distance },
        }));
      return json(200, { data: { Get: { [name]: hits } } });
    }
    return json(404, {});
  };
  return { fetch: fetch as typeof globalThis.fetch, classes };
}
