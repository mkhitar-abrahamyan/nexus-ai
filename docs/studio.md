# The studio

<!-- covers: -->

A UI for what a nexus-ai-pro application records: traces, threads, approvals, experiments, prompts,
context bundles, issues found in traces, proposed fixes, costs, provider health, and the operation
queue. Local and token-only by default, or shared by a team with accounts and roles, signed in with
your identity provider, and across tenants. It is a separate package,
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
| Traces | `traces` | Filter runs by status, kind, name, model, and time; open a run tree with inputs, outputs, cost, latency, a tool's progress, and each run's events and links; follow a link to the run it names; compare two traces; record feedback on a run |
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
  a person is inserted as text, never as HTML. A link from a record is rendered only when it is
  `http` or `https`.
- A request body is at most `maxBodyBytes`, 1 MiB by default. A larger one is refused with `413` as
  it arrives, before anyone is signed in. A change sends its body as `application/json`, a JSON
  object, or it is refused with `415` or `400`.
- A list returns at most 1,000 items, the audit log 10,000 entries, the issues view 90 days, and the
  costs view 366 days. Asking for more is a `400`, so no request makes a store read everything.
- `Studio.routes` lists every `StudioRoute`: its method, path, the role it needs, and the action
  the audit log records for it.
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

Or the studio signs people in itself, with no proxy in front: see [Signing people in](#signing-people-in).

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

With accounts, every change must carry the person's page token, or bring its own bearer token in an
`Authorization` header, as a script does. That stops another site from using a signed-in browser
against the studio. A browser adds Basic credentials to another site's request by itself, so they
are not proof, and a change refused for want of the page token is audited. `csrfToken()`
derives the page token from a server `secret` and the user, and the page reads it from its session.
Give several replicas the same `secret`.

People act as themselves: a request body cannot name someone else as the reviewer or promoter.

Every change, and every attempt a role refused, goes into the audit log as a `StudioAuditEntry`: who,
their role, the action, the outcome, and when. Comments attach to runs, review items, proposals,
threads, experiments, prompts, and bundles, each as a `StudioComment`.

The log is a `StudioAuditLog`, and comments a `StudioCommentStore`. Two classes implement both:

- `MemoryStudioJournal`, the default, bounded by `MemoryStudioJournalOptions`: 10,000 audit entries
  and 10,000 comments, the oldest dropped first;
- `FileStudioJournal`, append-only JSON Lines files that survive a restart and can be shipped to a log
  system as they are. On the command line, `--journal <directory>`.

With accounts, the studio can safely listen beyond the loopback interface:

- the host name goes in `allowedHosts`;
- the session cookie is marked `Secure` when the studio is reached over HTTPS;
- a studio listening on the network with only its single token warns at start.

`options.insights.slowMs` sets the latency the issues view reports as slow.

## Signing people in

`oidcSignIn()` signs people in with any OpenID Connect provider, given its issuer, the studio's
client id, and a role for each person. Give the `StudioSignIn` it returns to the studio as `signIn`:

```js
// studio.config.mjs
import { FileStudioJournal, oidcSignIn } from 'nexus-ai-pro-studio';

export default { traces, prompts: registry };
const journal = new FileStudioJournal('/var/lib/nexus-studio');
export const options = {
  host: '0.0.0.0',
  allowedHosts: ['studio.example.com'],
  signIn: oidcSignIn({
    issuer: 'https://login.example.com',
    clientId: 'nexus-studio',
    clientSecret: process.env.STUDIO_CLIENT_SECRET,
    redirectUri: 'https://studio.example.com/auth/callback',
    role: ({ groups = [] }) => (groups.includes('ml-admins') ? 'admin' : groups.includes('ml') ? 'editor' : undefined),
    secret: process.env.STUDIO_SECRET,
  }),
  secret: process.env.STUDIO_SECRET,
  audit: journal,
  comments: journal,
};
```

Someone who opens the studio without a session is sent to `/auth/login`, which sends them on to the
provider: the authorization code flow, with PKCE, a state, and a nonce, kept in a signed cookie for the
ten minutes they have to finish. `/auth/callback` exchanges the code, verifies the ID token against
the provider's keys, its issuer, the client as its audience, and the nonce, and takes them back to the
page they opened. `/auth/logout` signs them out, and out of the provider too when its configuration
has an `end_session_endpoint`. The page shows a link to it.

`OidcSignInOptions`:

- `role` decides each person's role from their ID token's claims, and `undefined` keeps them out;
- `id` picks their id, `sub` by default, and `tenant` their tenant;
- `clientSecret` makes a confidential client, sent in a Basic header, or in the body when the
  provider takes only that. Without it the studio signs in as a public client, by PKCE alone;
- `scopes` replaces `profile email`; `openid` is always asked for;
- `redirectUri` is the callback as registered with the provider. It defaults to `/auth/callback` on
  the address the request came to, so set it behind a proxy;
- `secret` signs the cookies: at least 32 characters, the same on every replica;
- `maxAgeSec` is how long a session lasts, 8 hours by default.

The session is a signed, HTTP-only cookie, `SIGN_IN_COOKIE`, so replicas that share the secret share
sessions, with no store. It is `SameSite=Lax`, so the page the provider sends someone back to opens
signed in; a change still needs the page token. `auth`, when also given, is asked first, so scripts
send bearer tokens to the same studio. Any flow of the same shape works as `signIn`: an
`authenticate` for a request's session, and a `handle` for the paths under `/auth/`.

`oidcSignIn()` needs nexus-ai-pro 2.3 or newer, for its token verifier.

## Tenants

One studio can serve many tenants. A `StudioUser` with a `tenant` reads the sources
`tenantSources` gives for it, instead of the studio's own:

```js
// studio.config.mjs
import { tenantScope } from 'nexus-ai-pro/tenancy';

export default {}; // Everyone belongs to a tenant, so the studio's own sources are empty.
export const options = {
  signIn: oidcSignIn({ ...provider, tenant: (claims) => claims.org_id }),
  tenantSources: async (tenant) =>
    (await customers.has(tenant)) ? tenantScope(tenant, { traces, prompts, datasets, experiments }) : undefined,
};
```

Each tenant's sources are opened once and kept. A tenant `tenantSources` does not know, by returning
`undefined`, is refused with `403`, as is anyone with a tenant on a studio given no `tenantSources`.
A tenant whose sources fail to open is an error, and is opened again on the next request.

- Comments record their author's tenant, and only that tenant's people see them.
- Audit entries record the tenant too. A tenant's admin reads their tenant's entries alone, whatever
  the audit log does with the filter; an admin without a tenant reads every entry, or one tenant's with
  `?tenant=`. A `StudioAuditQuery` is what `StudioAuditLog.list()` is asked.
- A page token is bound to its tenant, so a page in one tenant cannot carry a change in another.

The authenticators carry the tenant: `oidcSignIn()` and `bearerAuth()` take a `tenant` function of
the claims, and `headerAuth()` a `tenant` header, after which a request without it is refused. Each
person given to `personalTokens()`, and each entry of `--users`, may name a `tenant`.

Someone without a tenant reads the studio's own sources: the operators' view.

## Pieces you can reuse

`layoutGraph()`, re-exported from `nexus-ai-pro/graph/visualize`, lays a graph out in layers for
drawing. It returns a `GraphLayout` of `LaidOutNode` and `LaidOutEdge` values. Edges that point back
up — cycles — are marked, so they can be drawn around the side.

`parseArgs()` and `loadSources()` are the command's own argument parser and config loader.
`loadConfig()` also reads the `options` a config module exports.

## Limitations

- Someone without a tenant reads the studio's own sources. Give a studio where everyone belongs to a
  tenant empty sources of its own.
- Each tenant's sources stay open while the studio runs.
- A session is a signed cookie, not a record, so one person's cannot be ended before it expires.
  Rotate the sign-in `secret` to sign everyone out. A new role applies at the next sign-in.
- Signing out is a plain link, so another site can sign someone out of the studio, though never in.
- A page token stays valid while the `secret`, the user, and their role do. Rotate the secret to
  revoke every page at once.
- Someone without a session who opens another person's personal link is signed in as that person.
  The page shows who is signed in.
- `FileStudioJournal` reads its whole file for each listing, so rotate a long-lived one.
- It reads what the stores can list. An operation store without `list()` hides the queue, and a
  graph given without a way to list threads can only open a thread by id.
- Without `rollups`, the costs view reads up to 100,000 runs in its window, which is slow on a very
  large trace store. Give it rollups.
