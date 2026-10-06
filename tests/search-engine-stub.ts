/**
 * An in-memory stand-in for the parts of the Elasticsearch REST API the keyword index uses: index
 * creation, `_bulk` with NDJSON, `_search` with an OR `match` ranked by BM25 and `term` filters,
 * `_count`, and authentication. The same contract test then runs without a cluster.
 */
import { KeywordIndex } from '../src/rag/retrievers.js';

type Source = { id: string; content: string; source: string | null; metadata: Record<string, unknown> | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

export function elasticsearchStub(options: { apiKey?: string } = {}) {
  const indexes = new Map<string, { docs: Map<string, Source>; bm25: KeywordIndex; mappings: unknown }>();
  const requests: Array<{ method: string; path: string; contentType?: string; authorization?: string }> = [];

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      contentType: headers.get('content-type') ?? undefined,
      authorization: headers.get('authorization') ?? undefined,
    });
    if (options.apiKey && headers.get('authorization') !== `ApiKey ${options.apiKey}`) {
      return json(401, { error: { type: 'security_exception' } });
    }
    const [, name, action] = url.pathname.split('/');
    const body = typeof init.body === 'string' ? init.body : '';

    if (name === '_bulk' && method === 'POST') {
      const lines = body
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const items: unknown[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const [op, meta] = Object.entries(lines[index] as Record<string, { _index: string; _id: string }>)[0] as [
          string,
          { _index: string; _id: string },
        ];
        const target = indexes.get(meta._index);
        if (!target) {
          items.push({ [op]: { status: 404, error: { reason: 'no such index' } } });
          if (op === 'index') index += 1;
          continue;
        }
        if (op === 'index') {
          const doc = lines[++index] as Source;
          target.docs.set(meta._id, doc);
          target.bm25.add([{ id: meta._id, content: doc.content }]);
          items.push({ index: { status: 201 } });
        } else if (op === 'delete') {
          const existed = target.docs.delete(meta._id);
          target.bm25.delete([meta._id]);
          items.push({ delete: existed ? { status: 200 } : { status: 404, error: undefined, result: 'not_found' } });
        }
      }
      const errors = items.some((item) => Object.values(item as Record<string, { error?: unknown }>)[0]?.error);
      return json(200, { errors, items });
    }

    const target = name ? indexes.get(name) : undefined;
    if (!action) {
      if (method === 'HEAD') return new Response(null, { status: target ? 200 : 404 });
      if (method === 'PUT') {
        if (target) return json(400, { error: { type: 'resource_already_exists_exception' } });
        indexes.set(name as string, { docs: new Map(), bm25: new KeywordIndex(), mappings: JSON.parse(body).mappings });
        return json(200, { acknowledged: true });
      }
    }
    if (!target) return json(404, { error: { type: 'index_not_found_exception' } });
    if (action === '_count') return json(200, { count: target.docs.size });
    if (action === '_search') {
      const request = JSON.parse(body) as {
        size: number;
        query: {
          bool: { must: Array<{ match: { content: { query: string } } }>; filter: Array<Record<string, unknown>> };
        };
      };
      const query = request.query.bool.must[0]?.match.content.query ?? '';
      const ranked = await target.bm25.retrieve(query, { topK: target.docs.size || 1 });
      const hits = ranked
        .map((hit) => ({ hit, doc: target.docs.get(hit.id) as Source }))
        .filter(({ doc }) =>
          request.query.bool.filter.every((clause) => {
            if ('term' in clause) {
              const [field, value] = Object.entries(clause.term as Record<string, unknown>)[0] as [string, unknown];
              return doc.metadata?.[field.replace(/^metadata\./, '')] === value;
            }
            const field = (clause.bool as { must_not: { exists: { field: string } } }).must_not.exists.field.replace(
              /^metadata\./,
              '',
            );
            return doc.metadata?.[field] === undefined || doc.metadata?.[field] === null;
          }),
        )
        .slice(0, request.size)
        .map(({ hit, doc }) => ({ _id: hit.id, _score: hit.score, _source: doc }));
      return json(200, { hits: { hits } });
    }
    return json(400, { error: { type: 'unsupported' } });
  };

  return { fetch: fetch as typeof globalThis.fetch, requests, indexes };
}
