import type { Store, StoreItem, StoreNamespace, StorePutOptions, StoreSearchOptions } from '../types/store.js';
import { assertTenantId } from '../utils/tenant.js';

/** The first namespace part under which every tenant's items live, so they never meet an application's own. */
export const TENANT_NAMESPACE = 'nexus:tenant';

/**
 * One tenant's view of a long-term store: every namespace it reads or writes is placed under
 * `['nexus:tenant', tenantId]`, and every item it returns has that prefix taken off again. A search
 * or a namespace listing cannot reach past it, so another tenant's items are not merely filtered out
 * but never read. Works over any store — memory, Redis, Postgres, SQLite — with no schema change.
 *
 * A graph run given a `tenantId` sees its store through this view as `context.store`.
 */
export function tenantStore(store: Store, tenantId: string): Store {
  const root = [TENANT_NAMESPACE, assertTenantId(tenantId)];
  const scope = (namespace: StoreNamespace): string[] => [...root, ...namespace];
  const unscope = <V>(item: StoreItem<V>): StoreItem<V> => ({ ...item, namespace: item.namespace.slice(root.length) });
  return {
    put<V>(namespace: StoreNamespace, key: string, value: V, options?: StorePutOptions) {
      return store.put(scope(namespace), key, value, options);
    },
    async get<V>(namespace: StoreNamespace, key: string) {
      const item = await store.get<V>(scope(namespace), key);
      return item ? unscope(item) : undefined;
    },
    delete(namespace: StoreNamespace, key: string) {
      return store.delete(scope(namespace), key);
    },
    async search<V>(namespacePrefix: StoreNamespace, options?: StoreSearchOptions) {
      return (await store.search<V>(scope(namespacePrefix), options)).map(unscope);
    },
    async listNamespaces(options: { prefix?: StoreNamespace; limit?: number } = {}) {
      const namespaces = await store.listNamespaces({
        prefix: scope(options.prefix ?? []),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return namespaces.map((namespace) => namespace.slice(root.length)).filter((namespace) => namespace.length > 0);
    },
  };
}
