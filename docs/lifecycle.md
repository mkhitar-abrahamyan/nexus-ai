# One lifecycle for every operation

<!-- covers: ./lifecycle -->

Every call the client makes passes through the same stages, whichever family makes it. A completion,
a stream, an embedding, a transcription, a phone call, an image, a realtime session, a graph run, an
agent run, a queued job, and a provider batch share:

- one authorization callback, which can refuse any of them before a provider sees it;
- one spend budget, held before each call and charged what the call actually cost;
- one set of hooks, which see every call start and finish, including cache hits;
- one audit log and one metrics collector, labelled by family.

You configure all of it once, as `lifecycle` on the client. `nexus-ai-pro/lifecycle` holds the budget
and the types; the runner and its errors are on the root as well.

```ts
import { NexusAI, OperationDeniedError } from 'nexus-ai-pro';
import { budgetLedger } from 'nexus-ai-pro/lifecycle';

const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  lifecycle: {
    authorize: (operation) => operation.userId !== undefined,
    budget: budgetLedger({ limit: 50, period: 'day' }),
    hooks: {
      onFinish: (operation, outcome) => console.log(operation.family, operation.operation, outcome.status),
    },
  },
});
```

## The stages

`LIFECYCLE_STAGES` lists them in order, each a `LifecycleStage`. A family skips a stage it has nothing
for.

| Stage | What happens |
| --- | --- |
| `validate` | The family checks the request's shape. |
| `authorize` | The rate limit, then your `authorize` callback. A refusal stops the call here. |
| `inputPolicy` | Guardrails on the input: security checks, safety policies, trimming. |
| `resolveAssets` | Images and files the request names are loaded. |
| `route` | The provider and model are chosen. |
| `reserveBudget` | The estimated cost is held against the budget. |
| `execute` | The provider is called, or a cache answers. |
| `outputPolicy` | Guardrails on the output. |
| `persist` | What outlives the call is stored, such as a cache entry. |
| `reconcileCost` | The hold is replaced by what the call cost. |
| `audit` | The response is audited and counted, and `onFinish` runs. |

Every operation is described by an `OperationDescriptor`: its `OperationFamily`, its name, its request
id, the provider and model once routing chose them, and the user and tenant it runs for. That is what
your callback, the budget, and your hooks receive.

| Family | Operations |
| --- | --- |
| `completion` | `complete`, `stream`, and `summarize` for a context-window summary |
| `embedding` | `embed` |
| `voice` | `transcribe`, `speak` |
| `telephony` | `createCall`, `getCall`, `endCall`, `listPhoneNumbers`, `updatePhoneNumber` |
| `image` | `images.generate`, `images.edit` |
| `realtime` | `realtime.session`, from connect to disconnect |
| `graph` | `graph.run`, `graph.<name>` for a named graph, and `workflow.<name>` |
| `agent` | `agent` for `ai.agent()`, and `agent.<name>` for `createAgent()` |
| `job` | `job`, once per attempt |
| `batch` | `batch.submit`, from submission to collection |

## Authorization

`authorize` receives each operation and decides whether it may run. Return `false`, or throw, to
refuse it. Either way the call fails with `OperationDeniedError` before any provider is called, and
the error carries the operation it refused. A throw's message becomes the reason.

```ts
lifecycle: {
  authorize: async (operation) => {
    if (operation.family === 'telephony' && !(await canPlaceCalls(operation.userId))) {
      throw new Error('this account cannot place calls');
    }
    return true;
  },
},
```

The callback runs for every family. An admin-only operation, such as `updatePhoneNumber`, is refused
the same way as a completion.

## A shared budget

`budgetLedger()` builds a `BudgetLedger` that every family draws on. Before a call runs, its estimated
cost is held; afterwards the hold becomes what the call actually cost, and a failed call gives it back.
Adding first and then checking the new total is what keeps concurrent calls from overshooting the
limit together.

| `BudgetLedgerOptions` | Default | What it sets |
| --- | --- | --- |
| `limit` | — | US dollars per period: one number for every budget, or a function of the budget's key. |
| `period` | `month` | A `BudgetPeriod`: `hour`, `day`, `week`, `month` in UTC, or `{ windowMs }`. |
| `key` | the tenant, then `default` | Which budget an operation draws on. Return `undefined` to leave it untracked. |
| `store` | process memory | Where totals live, a `BudgetUsageStore`. |

```ts
import { budgetLedger } from 'nexus-ai-pro/lifecycle';
import { RedisTenantUsage } from 'nexus-ai-pro/server/tenancy';

const budget = budgetLedger({
  limit: (tenant) => plans[tenant]?.dailyUsd,
  period: 'day',
  store: new RedisTenantUsage(redis),
});
console.log(await budget.spent('acme'));
```

A call that does not fit fails with `BudgetExceededError`. It names the budget, the estimate, and
what was left. A budget that is already spent refuses even a call estimated at nothing, since an
estimate can be missing.

The pieces underneath:

- `BudgetUsageStore` needs two operations, `add()` and `total()`. `MemoryBudgetUsage` is the default.
  `MemoryTenantUsage` and `RedisTenantUsage` from the server's tenancy module fit as they are, so one
  Redis counts both tenant runs and model spend.
- `BudgetLedgerWithReport` is what `budgetLedger()` returns: the ledger, plus `spent(key)` for this
  period's total.
- A `BudgetReservation` is one hold: the budget's key and the amount. Write your own `BudgetLedger`
  with `reserve()`, `reconcile()`, and `release()` when your spend lives elsewhere.

The budget is separate from `costBudget`, which caps one request's estimate. Both apply when both are
set.

## Hooks

`LifecycleHooks` has two:

- `onStart` runs once an operation is admitted;
- `onFinish` runs once it ends, however it ends, with an `OperationOutcome`.

The outcome's `status` is `succeeded`, `failed`, `cancelled`, or `denied` when authorization, a rate
limit, a budget, or a guardrail refused the call. It also says whether a cache answered, how long the
call took, what it cost, and the error when there was one. A throwing hook is ignored, so
observability can never fail a call.

`LifecycleConfig` is the whole setting: `authorize`, `budget`, and `hooks`.

## Graphs, agents, sessions, queues, and batches

Code outside the client takes the client's lifecycle as an option, `ai.lifecycle`. Its runs then
become operations of the client too.

| Where | Option |
| --- | --- |
| `graph.compile()` | `lifecycle` |
| `workflow()` | `lifecycle` |
| `createAgent()` | `lifecycle`, labelled `agent` |
| `createRealtimeSession()` | `lifecycle`, from connect to disconnect |
| `new JobQueue()` | `lifecycle`, once per attempt |
| `new BatchManager()` | `lifecycle` in its runtime |

```ts
const graph = builder.compile({ lifecycle: ai.lifecycle, name: 'triage' });
await graph.invoke(input); // one `graph.triage` operation, and one per model call inside it
```

These options take an `OperationLifecycleLike`: anything with a `start()` that admits an operation.
So `nexus-ai-pro/graph` and the other families depend on the lifecycle's types only.

## Writing a provider

Every provider call receives a `ProviderCallContext` beside its request. It holds the operation's
request id, its abort signal, its deadline, its trace headers, and its idempotency key. A chat
provider gets it as the second argument of `complete()` and `stream()`. Each family's own context
extends it: an image provider's adds the operation id, and an embedding provider's adds the attempt
and the batch index.

```ts
class MyProvider extends BaseProvider {
  async complete(request: CompletionRequest, context?: ProviderCallContext) {
    const response = await fetch(url, {
      signal: context?.signal,
      headers: { 'Idempotency-Key': context?.idempotencyKey ?? '' },
    });
    // ...
  }
}
```

The bundled OpenAI and Anthropic adapters send the idempotency key and the trace headers on.

## Running an operation of your own

`OperationLifecycle` is the runner, and the client builds one from `LifecycleRuntime`: its metrics,
audit log, rate limiter, and `LifecycleConfig`. `ai.lifecycle` is the client's own. There are two ways
to use it.

`run()` takes an `OperationPlan` and runs every stage in order. A plan's `execute` is required; its
`validate`, `inputPolicy`, `resolveAssets`, `route`, `estimate`, `outputPolicy`, `persist`, and
`settle` are optional.

```ts
const summary = await ai.lifecycle.run(
  { family: 'job', operation: 'nightly-summary', tenantId: 'acme' },
  {
    estimate: () => 0.02,
    execute: async (context) => summarize(documents, { signal: context.signal }),
    settle: (result) => ({ cost: result.cost }),
  },
);
```

`start()` is for an operation that outlives one call, such as a stream or a session. It admits the
operation and returns an `OperationTicket`:

- `context`, the `ProviderCallContext` to hand every provider call;
- `reserve()`, which holds an estimate against the budget;
- `succeed()`, with an `OperationResultInfo` of cost, cache hit, provider, and model;
- `fail()`, with the error that ended it.

`OperationStartOptions` add a caller's signal, a timeout, an idempotency key, and trace headers.

## In production

- Give every request a `tenantId` when a budget is kept per tenant. Without it, calls share the
  `default` budget.
- Use a shared store, such as Redis, once more than one process charges the same budget.
- Keep `authorize` fast: it runs before every call, cache hits included.
- Budgets hold estimates. A model with no registry price is estimated at nothing; register its price
  with `models.registry` so the budget sees it.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/lifecycle`

| Export | Kind | Summary |
| --- | --- | --- |
| `BudgetExceededError` | class | Raised when an operation's estimated cost does not fit what is left of its budget. |
| `budgetLedger` | function | A spend budget shared by every family of a client. |
| `BudgetLedger` | interface | Spend shared by every family. |
| `BudgetLedgerOptions` | interface | Options for `budgetLedger()`. |
| `BudgetLedgerWithReport` | interface | A ledger that can also say what a budget has spent this period. |
| `BudgetReservation` | interface | Spend held for an operation between `reserveBudget` and `reconcileCost`. |
| `BudgetUsageStore` | interface | Where a ledger keeps its totals: a sum per key that resets at a given time. |
| `LIFECYCLE_STAGES` | constant | Every lifecycle stage, in the order an operation passes through them. |
| `LifecycleConfig` | interface | What every operation of a client shares. |
| `LifecycleHooks` | interface | Code that runs around every operation of every family. |
| `LifecycleRuntime` | interface | What a lifecycle reports into. |
| `LifecycleStage` | type | The stages every operation passes through, in this order. |
| `MemoryBudgetUsage` | class | Budget totals in process memory. |
| `OperationDeniedError` | class | Raised when `lifecycle.authorize` refuses an operation, before any provider is called. |
| `OperationDescriptor` | interface | One operation, as authorization, budgets, hooks, audit, and metrics see it. |
| `OperationFamily` | type | The families an operation can belong to. |
| `OperationLifecycle` | class | Runs operations of every family through the same stages: validate, authorize, input policy, resolve assets, route, reserve budget, execute, output policy, persist, reconcile cost, and audit. |
| `OperationLifecycleLike` | interface | The part of a client's lifecycle a module outside the core needs: a graph, an agent, or a realtime session given one runs as an operation of that client. |
| `OperationOutcome` | interface | How an operation ended, as `onFinish` receives it. |
| `OperationPlan` | interface | The family's part of one operation: what each stage does for it. |
| `OperationResultInfo` | interface | What a finished operation reports, for budgets, metrics, audit, and hooks. |
| `OperationStartOptions` | interface | Options for admitting one operation. |
| `OperationTicket` | interface | An admitted operation that has not finished yet. |
| `ProviderCallContext` | interface | What every provider call receives besides its request, in every family: how to stop, when to finish by, and what to carry to the provider. |
<!-- reference:end -->
