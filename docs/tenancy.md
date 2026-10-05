# Tenancy

<!-- covers: ./tenancy -->

One tenant model for everything that stores data. A request, a graph run, and a server run carry a
`tenantId`, and every store has a tenant view that implements the store's own contract: a tenant's
code takes a `TraceStore`, a `PromptStore`, or a `VectorStore` as it always did, and cannot reach
past its tenant.

```ts
import { tenantScope } from 'nexus-ai-pro/tenancy';

// In a request handler, once the principal is known:
const scoped = tenantScope(principal.tenantId, { store, traces, prompts, vectors, cache });
const answer = await scoped.vectors.search(question, { topK: 5 });
```

The views work over the memory, Redis, Postgres, SQLite, and file stores alike, with no schema
change. They are checked by an isolation suite that runs against every storage adapter and fails on
any cross-tenant get, list, search, delete, fork, resume, trace query, vector search, or cache hit.

## Tenant ids

A tenant id is 1 to 128 letters, digits, underscores, and hyphens. `assertTenantId()` returns a valid
one unchanged and throws `TenantIdError` otherwise, and every view checks its id the same way. The
rule is what makes prefixing safe: a scoped name is `tenant/<id>/<name>`, and since no id holds a
`/`, no tenant's prefix is the start of another's — `acme` can never read `acme-x`'s names.

## Scoped views

Each function takes a store and a tenant id and returns that tenant's view of it:

| Function | Scopes | How |
| --- | --- | --- |
| `tenantStore()` | long-term memory | every namespace placed under `['nexus:tenant', tenantId]` (`TENANT_NAMESPACE` is the first part); searches and namespace listings cannot reach past it |
| `tenantTraceStore()` | traces | runs saved through it are stamped `metadata.tenantId`; `get()`, `query()`, `tree()`, and feedback see only stamped runs |
| `tenantOperationStore()` | operations | records carry `tenantId`, idempotency keys are prefixed so two tenants' keys never collide, and queue reads pass the tenant as a filter |
| `tenantPromptStore()` | prompts, and context hub bundles | names prefixed on the way in and taken off on the way out |
| `tenantDatasetStore()`, `tenantExperimentStore()` | datasets, experiments | names, ids, and dataset names prefixed |
| `tenantVectorStore()` | retrieval chunks | ids prefixed, metadata stamped `tenantId`, and every search filtered by it |
| `tenantCache()` | a cache adapter | keys prefixed |
| `tenantAssetStore()` | assets | the tenant bound once, so no call can name another; a `TenantAssetStore` |
| `tenantRollupStore()` | dashboard rollups | rows added and read under the tenant |

`tenantScope()` builds every view at once from a `TenantStores` object, keeping each store's type
and passing through anything it was not asked to scope.

What a view refuses is the same everywhere: another tenant's record reads as missing, a delete or
an update reaches only the caller's own, and a listing or search never returns another tenant's
item. Methods that would act on every tenant at once — `TraceStore.prune()` and `CacheAdapter.clear()`
— are left off the views; run them against the shared store from operations code.

A context hub needs nothing of its own: give a `ContextHub` the tenant's prompt store, and its
bundles, labels, and history are the tenant's.

```ts
const hub = new ContextHub({ store: tenantPromptStore(prompts, tenantId) });
```

## Where the tenant flows

- **Requests.** `CompletionRequest.tenantId` charges a shared budget to the tenant and is recorded on
  the request's trace as `metadata.tenantId`, which hourly rollups count by. The semantic response
  cache only matches entries of the same tenant; see the [caching guide](./caching.md) for cache
  namespaces.
- **Graph runs.** `tenantId` is a run option. It is recorded on every checkpoint as
  `metadata.tenantId`, nodes read it as `context.tenantId`, and `context.store` is the tenant's view of
  the graph's store. A thread another tenant owns is not found: resuming, continuing, forking, or
  editing it under a different tenant fails with `GraphThreadNotFoundError` before anything runs, and
  `state()` and `history()` given a `tenantId` read it as absent. A run without a `tenantId` carries
  on its thread's. The [graphs guide](./graphs.md) has the details.
- **The agent server.** `graphAssistant()` passes the principal's tenant into every graph run, so a
  server run's checkpoints and store are the tenant's own. The server already scopes threads and runs
  by tenant, and `tenantLimits()` caps each tenant's active runs, rate, and spend; the
  [deployments guide](./deployments.md) covers them.
- **Rate limits and budgets.** A client's `rateLimit.key: 'tenantId'` gives each tenant its own
  limit, so one tenant cannot spend another's share, and a shared spend budget charges each
  operation to its `tenantId` by default.
- **Operations.** `OperationSubmitOptions.tenantId` records the tenant on an operation, and
  `OperationStoreFilter.tenantId` narrows `listQueued()` and `stats()`, which Postgres and SQLite
  answer from an index of queued work by tenant.

## Limitations

- A view is a boundary for code that is handed the view. Code holding the shared store can still
  read every tenant; give a tenant's handlers only its views.
- Prefixing changes what is stored: a prompt named `support` is stored as `tenant/acme/support`.
  Data written before a view was used is not the tenant's until it is copied under its prefix.
- A tenant's trace queries in Postgres use the index version 2 of the trace schema adds; other stores
  filter as they always do.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/tenancy`

| Export | Kind | Summary |
| --- | --- | --- |
| `assertTenantId` | function | Returns a tenant id unchanged, or throws `TenantIdError` when it is not one. |
| `TENANT_NAMESPACE` | constant | The first namespace part under which every tenant's items live, so they never meet an application's own. |
| `tenantAssetStore` | function | One tenant's assets. |
| `TenantAssetStore` | interface | An asset store with the tenant bound, so no call can name another. |
| `tenantCache` | function | One tenant's cache: every key placed under the tenant's prefix, so a tenant can never read what another cached. |
| `tenantDatasetStore` | function | One tenant's datasets: names placed under the tenant's prefix, and `list()` showing only its own. |
| `tenantExperimentStore` | function | One tenant's experiments. |
| `TenantIdError` | class | Refused when a tenant id is empty, too long, or holds a character a scoped key could be split on. |
| `tenantOperationStore` | function | One tenant's operations. |
| `tenantPromptStore` | function | One tenant's prompts. |
| `tenantRollupStore` | function | One tenant's rollups: rows it adds are counted for the tenant, and queries read only the tenant's rows. |
| `tenantScope` | function | Scopes every given store to one tenant at once, keeping each one's type, so a request handler builds its tenant's view in one line. |
| `tenantStore` | function | One tenant's view of a long-term store: every namespace it reads or writes is placed under `['nexus:tenant', tenantId]`, and every item it returns has that prefix taken off again. |
| `TenantStores` | interface | The stores `tenantScope()` can scope. |
| `tenantTraceStore` | function | One tenant's traces. |
| `tenantVectorStore` | function | One tenant's retrieval chunks. |
<!-- reference:end -->
