# The studio (experimental)

<!-- covers: -->

A UI for what a nexus-ai-pro application records: traces, threads, approvals, experiments, prompts,
context bundles, issues found in traces, proposed fixes, costs, provider health, and the operation
queue. Local and token-only by default, or shared by a team with accounts and roles. It is a separate package,
`nexus-ai-pro-studio`, so the core install never carries a UI. It runs wherever you start it — your
machine, or a server your team reaches — reads your application's own stores through the adapters
it already uses, and needs no hosted service.

## Starting it

```bash
npm install --save-dev nexus-ai-pro-studio
npx nexus-studio --config studio.config.mjs
```

The configuration module's default export is the studio's sources — or a function, possibly async,
that returns them. It is ordinary application code, so it opens the stores the application opens:

```js
// studio.config.mjs
import { PostgresTraceStore } from 'nexus-ai-pro/postgres/traces';
import { PostgresExperimentStore, PostgresDatasetStore } from 'nexus-ai-pro/postgres/evaluate';
import { pool, supportGraph, checkpointer, registry, ai, reviewQueue } from './src/app.js';

export default {
  traces: new PostgresTraceStore(pool),
  experiments: new PostgresExperimentStore(pool),
  datasets: new PostgresDatasetStore(pool),
  graphs: { support: { graph: supportGraph, checkpointer } },
  reviews: { answers: reviewQueue },
  prompts: registry,
  client: ai,
  budgets: [{ name: 'production', limit: 200, period: 'month' }],
};
```

The command prints an address such as `http://127.0.0.1:4747/?token=…`; open it. `--port` picks the
port (`0` for any free one), `--token` fixes the token instead of generating one, and `--host` with
`--allow-host` bind somewhere other than the loopback interface. A TypeScript config works under a
loader: `node --import tsx node_modules/nexus-ai-pro-studio/dist/cli.js --config studio.config.ts`.

To start it from code instead — inside a dev server, say — `startStudio()` takes the same sources and
returns a `RunningStudio` with the `url`, `token`, `port`, and `close()`. `StartStudioOptions` adds the
port and host to the `StudioOptions` every entry point takes. `createStudio()` returns the bare
`Studio` handler, a `Request`-to-`Response` function, for mounting it in a server you already run.

`npm run studio:demo` in the repository starts it on a demo application with something in every view.

## What it shows

Every source is optional. The studio shows a view for each one it is given, and hides the rest.

| View | Source | What you can do |
| --- | --- | --- |
| Traces | `traces` | Filter runs by status, kind, name, model, and time; open a run tree with inputs, outputs, cost, and latency; compare two traces; record feedback on a run |
| Threads | `graphs` | See each graph's diagram with the next nodes highlighted; list threads; read state at any step; fork from a step; edit state; answer an interrupt |
| Inbox | `graphs`, `reviews`, `proposals` | Every thread waiting for a human, every review item waiting for a grade, and every proposed fix waiting for promotion, in one list |
| Issues | `traces` | Failing and slow runs clustered by what went wrong, and what got worse than the week before |
| Experiments | `experiments`, `datasets` | List experiments and datasets; compare two experiments with per-metric intervals and a verdict |
| Prompts | `prompts`, `client` | Versions, labels, and history; diff two versions; promote through the registry's gates; roll back; render and run a version in the playground |
| Bundles | `contexts` | Context bundle versions, labels, and history; diff two versions; promote through the hub's gates; roll back |
| Deployments | `deployments`, `operations`, `tenants` | Each assistant's traffic split and history; each revision's runs, error rate, and latency since the last change; replicas and their health; the queue; tenant usage. Admins start a canary, promote, and roll back |
| Audit | accounts | Every change, and every refused attempt, with who and when — for admins |
| Costs | `traces`, `budgets` | Cost per day and per model, the most expensive runs, and each budget with what it has spent |
| Health | `client`, `circuits` | Provider health scores, circuit states — local and shared across workers — metrics, and cache statistics |
| Operations | `operations`, `assets` | The operation queue by status, with leases and errors; asset store totals |

## The sources

`StudioSources` is the whole configuration. Each field is structural, and the real objects satisfy
it as they are:

- `traces` is any `TraceStore`: memory, JSONL, or Postgres.
- `graphs` maps a name to a compiled graph, or to a `StudioGraphSource` of the graph and how to list
  its threads — its `checkpointer`, or a `threads()` function. `StudioGraphLike` is the part of a
  compiled graph the view uses; `StudioCheckpoint` and `StudioInterrupt` are what it reads.
  `MemoryGraphCheckpointer` and the operation-store checkpointer (Redis, Postgres, SQLite) both list their
  threads; a graph given alone can still open a thread by id.
- `reviews` maps a name to an annotation queue, through `StudioReviewQueue`.
- `datasets` and `experiments` are any `DatasetStore` and `ExperimentStore`.
- `prompts` is a `PromptRegistry`, as `StudioPromptRegistry`.
- `contexts` is a `ContextHub`, as `StudioContextHub`.
- `proposals` is a `ProposalInbox` from `nexus-ai-pro/insights`, as `StudioProposalInbox`: the fixes
  waiting for a person, which admins promote — through the label's gates — and editors reject.
- `client` is a `NexusAI` client, as `StudioClient`: its `complete()` runs the playground, and its
  health, circuit, metrics, and cache methods fill the health view. Each is optional.
- `circuits` is a shared circuit store, as `StudioCircuitStore`, for a deployment whose workers
  share circuit state.
- `operations` is an operation store that can list, as `StudioOperationStore`. Graph checkpoint
  records that live in the same store are left out of the queue. A store with `stats()` also gives
  the deployments view its queue numbers.
- `deployments` is a `Deployments` registry from `nexus-ai-pro/server/deployments`, as
  `StudioDeployments`. Build it on the agent server's state store, with no assistants: the studio
  reads and changes what the servers record, and every change is checked against the version shown.
- `tenants` is the limiter from `tenantLimits()`, as `StudioTenants`, whose `report()` fills the
  tenant table.
- `assets` is an asset store, as `StudioAssetStore`: its `snapshot()` totals, and a listing when it
  has one.
- `budgets` is a list of `StudioBudget` values: a name, a limit in US dollars, a period of a day, a
  week, or a month, and an optional trace filter for which runs count.

The costs view counts model runs, which is where the tracer records cost, so a parent run that sums
its children is not counted twice. `StudioCostReport` is the shape it returns.

`rollups`, a `StudioRollups`, makes the costs view read hourly totals instead of traces: give it the
rollup store behind `rollupTraceStore()` from `nexus-ai-pro/tracing/rollups`. Each `StudioRollupRow`
is an hour of one kind, model, provider, and tenant. A month of a million runs is a few thousand rows,
so the view answers in milliseconds however large the trace store grows. The costliest runs still come
from the traces, from the most recent 1,000 in the window, and a budget whose filter needs more than a
model, provider, kind, or name still reads the traces.

## Access and safety

The studio can change things — answer an interrupt, edit a thread, promote a prompt — so it is
locked down, even on its local default:

- It binds `127.0.0.1` by default, so nothing else on the network can reach it.
- Every request needs the token. It arrives once, in the URL the command prints; the studio moves it
  into an HTTP-only, same-site cookie and takes it out of the address bar. `createToken()` generates
  one, and `tokensMatch()` compares in constant time.
- A change must also carry the token in the `x-studio-token` header (`TOKEN_HEADER`), which a page on
  another site cannot set, so the cookie alone cannot be used against you. The page's own script reads
  the token from a same-origin session route; `SESSION_COOKIE` is the cookie's name.
- Requests whose `Host` is not a loopback name are refused, which closes DNS rebinding: a hostile
  page pointing its own domain at `127.0.0.1`. `hostAllowed()` is the check, and `allowedHosts` adds
  names when you bind elsewhere on purpose.
- Pages are served with a strict content security policy, and every value from a trace, a model, or
  a person is inserted as text, never as HTML.
- On the single token, actions are recorded under `actor` — `studio` by default — so a promotion's
  history says who moved the label.

Errors come back as JSON with a stable code, as a `StudioError`. A source that was not configured is a
`404`, a refused promotion a `409` with each gate's verdict, and a malformed request a `400`.

## Sharing it with a team

Give the studio `auth` and each person signs in with a role; everything they do is recorded under
their id. A `StudioAuthenticator` decides who a request is from — a `StudioUser` with an id, a name,
an email, and a `StudioRole` — given the request and a `StudioRequestInfo` with the address it came
from. `STUDIO_ROLES` lists the roles, each including the ones before it, and `hasRole()` compares:

| Role | May also |
| --- | --- |
| `viewer` | Read every view |
| `reviewer` | Answer interrupts, submit reviews, record feedback, and comment |
| `editor` | Edit and fork threads, run the playground, and reject proposals |
| `admin` | Promote and roll back prompts, bundles, and proposals, and read the audit log |

Four authenticators come bundled:

- `personalTokens()` gives each person their own link, for a small team without an identity provider.
  The CLI reads them from a file: `--users users.json`, a list of `{ "id", "name", "role", "token" }`,
  which `loadUsers()` reads.
- `headerAuth()` trusts the identity headers set by a reverse proxy that signs people in, such as an
  OIDC proxy or an access gateway. It trusts them only from the proxy: `HeaderAuthOptions` needs a
  secret header the proxy adds, or the proxy's addresses. It also maps groups to roles.
- `bearerAuth()` accepts an `Authorization: Bearer` token checked by the function you pass — an OIDC
  token verified against the issuer's keys — for scripts and services; `BearerAuthOptions` maps its
  claims to a role.
- `anyOf()` tries several in turn, such as bearer tokens for scripts and a proxy for people.

```js
// studio.config.mjs
import { headerAuth, FileStudioJournal } from 'nexus-ai-pro-studio';

export default { traces, prompts: registry, contexts: hub, proposals: inbox };
const journal = new FileStudioJournal('/var/lib/nexus-studio');
export const options = {
  host: '0.0.0.0',
  allowedHosts: ['studio.internal.example.com'],
  auth: headerAuth({
    secret: { header: 'x-proxy-secret', value: process.env.PROXY_SECRET },
    role: ({ groups }) => (groups.includes('ml-admins') ? 'admin' : groups.includes('ml') ? 'editor' : 'viewer'),
  }),
  audit: journal,
  comments: journal,
};
```

With accounts, every change must carry the person's page token, or bring its own `Authorization`
header. That stops another site from using a signed-in browser against the studio. `csrfToken()`
derives the page token from a server `secret` and the user, and the page reads it from its session.
Give several replicas the same `secret`.

People act as themselves: a request body cannot name someone else as the reviewer or promoter.

Every change, and every attempt a role refused, goes into the audit log as a `StudioAuditEntry`: who,
their role, the action, the outcome, and when. Comments attach to runs, review items, proposals,
threads, experiments, prompts, and bundles, each as a `StudioComment`.

The log is a `StudioAuditLog`, and comments a `StudioCommentStore`. Two classes implement both:

- `MemoryStudioJournal`, the default, bounded by `MemoryStudioJournalOptions`;
- `FileStudioJournal`, append-only JSON Lines files that survive a restart and can be shipped to a log
  system as they are. On the command line, `--journal <directory>`.

With accounts, the studio can safely listen beyond the loopback interface:

- the host name goes in `allowedHosts`;
- the session cookie is marked `Secure` when the studio is reached over HTTPS;
- a studio listening on the network with only its single token warns at start.

`options.insights.slowMs` sets the latency the issues view reports as slow.

## Pieces you can reuse

`layoutGraph()`, re-exported from `nexus-ai-pro/graph/visualize`, lays a graph out in layers for
drawing. It returns a `GraphLayout` of `LaidOutNode` and `LaidOutEdge` values. Edges that point back
up — cycles — are marked, so they can be drawn around the side.

`parseArgs()` and `loadSources()` are the command's own argument parser and config loader.
`loadConfig()` also reads the `options` a config module exports.

## Limitations

- The studio is experimental: it is new, and its views will gain detail.
- It reads what the stores can list. An operation store without `list()` hides the queue, and a
  graph given without a way to list threads can only open a thread by id.
- Without `rollups`, the costs view reads up to 100,000 runs in its window, which is slow on a very
  large trace store. Give it rollups.
- Accounts come from an authenticator you configure; the studio does not run a sign-in flow of its
  own. For people in a browser, put a signing-in proxy in front, or give each person a link.
