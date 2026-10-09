# Security Policy

## Supported versions

Security fixes are provided for the latest published minor release. Upgrade to the newest patch of that line as fixes become available; older minor releases do not receive backports.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/mkhitar-abrahamyan/nexus-ai/security/advisories/new). Do not open a public issue for an undisclosed vulnerability and do not include real credentials, personal data, or exploit targets in a report.

Include the affected version, impact, a minimal reproduction, and any suggested mitigation. You can expect an acknowledgement within five business days. A confirmed issue will be coordinated privately until a fix and disclosure plan are ready.

## Scope and safe operation

Nexus guardrails reduce common AI application risks, but they are not a complete authorization or security boundary. Applications remain responsible for access control, provider-side safety controls, tool authorization, network egress policy, secret storage, and review of high-impact model actions.

## Realtime voice security

- Never ship a permanent provider API key to a browser or mobile client. For WebRTC, configure a
  same-origin `sessionEndpoint` that performs provider negotiation or returns a short-lived client
  secret. For WebSocket API-key authentication, run the transport on a trusted server and inject a
  WebSocket factory that can set authorization headers.
- Authenticate and authorize the session endpoint before contacting the provider. Restrict origins,
  apply CSRF and rate-limit controls, cap request size and duration, and derive the model, tools,
  instructions, retention, and safety settings from trusted server policy rather than client input.
- Treat microphone permission, remote audio, provider data-channel events, transcripts, and raw events
  as sensitive data. Request microphone access only after a user action, stop owned tracks on cleanup,
  minimize retention, and avoid putting transcripts or audio in logs and telemetry by default.
- Use `security.maxSessionDurationMs`, `security.maxAudioDurationMs`, `security.toolAllowlist`,
  `security.retainTranscripts`, `security.piiHook`, and bounded raw-event retention as defense-in-depth.
  These process-local controls do not replace tenant quotas, durable retention enforcement, or a DLP
  system.
- A realtime tool confirmation is a user-experience checkpoint, not authorization. Every read and write
  tool must enforce tenant access and validate arguments server-side. Writes should require explicit
  confirmation, use the supplied idempotency key, and remain safe under retries and duplicate provider
  events.
- Redact API keys, ephemeral tokens, SDP diagnostics, tool arguments/results, and PII from errors and
  telemetry. Realtime telemetry transcript fields are redacted by default; set
  `telemetry.includeTranscripts: true` only when the destination and retention policy are explicitly
  approved. `piiHook` applies to normalized events and conversation state, not retained raw events.
- Reconnects can repeat provider events or tool requests and do not guarantee restoration of remote
  conversation state. Keep write tools idempotent, deduplicate by call ID/idempotency key, and surface
  recovery failures to the user.
- Browser WebRTC still requires a backend security boundary. A direct media path reduces latency; it
  does not remove the need for server-owned credentials, session policy, tool authorization, abuse
  monitoring, and provider-side safety controls.

## Threat reviews

Every surface that leaves experimental status is reviewed for how untrusted input reaches it and
what it could do with that input. Each review is published here with its findings, which are closed
before the surface graduates. A finding is closed in one of two ways: by a fix with a test that
names the attack, or by a documented limitation that the surface's guide states.

These reviews were done for 2.4, and for 2.5 where a review says so.

### SQLite adapters

Trust boundary: an application's data, an operation's payload, and metadata filters that may come
from a request.
- Table names are checked against a strict pattern and quoted. Every value, including each metadata
  filter key and its JSON path, is a bound parameter, so a filter cannot change a statement.
- A migration records its checksum, and a changed migration is refused rather than reapplied.
- Every change to an operation is one `UPDATE … WHERE sequence = expected`, so two workers sharing
  a file never both claim it. The ten-worker race tests run on SQLite.
- Tenant data is scoped by key prefix, and the isolation suite runs on every SQLite store.

Findings: none.

### The Postgres and SQLite vector stores

Trust boundary: metadata filters, which applications often build from a request.
- The pgvector store sends a filter as one bound `jsonb` containment parameter, and quotes its table
  and index names.
- The SQLite store binds each key's JSON path and value, and matches a value's JSON type as well as
  its value, so `"1"` never matches `1`.

Findings: none.

### Loaders

Trust boundary: everything a loader reads is untrusted. A repository, a website, a sitemap, or an
uploaded file may be written by an attacker who wants it in a knowledge base, or who wants the
loader to read something else.
- Web pages and sitemaps go through the SSRF-safe fetch. Private, loopback, and cloud-metadata
  addresses are refused, every redirect is checked again, and bodies are capped.
- The Git loader runs `git` without a shell. It disables the `ext::` transport, puts `--` before
  the repository, and refuses a repository that starts with `-`.
- `loadDirectory()` does not follow symbolic links.

Findings, both fixed in 2.4:
- **The Git loader followed symbolic links.** A tracked link such as `notes.md` pointing to
  `~/.ssh/id_rsa` was read and ingested, so a knowledge base could quote a file of the host. A
  link is now never followed, nor a path that resolves outside the checkout. Proof: a repository
  holding a tracked link to a file outside it loads without that file, cloned and in place. On
  Linux, the test fails on the earlier loader.
- **A gzipped sitemap could be a decompression bomb.** A few megabytes of gzip inflated without a
  limit. Inflation now stops at 50 MB, the sitemap protocol's own maximum. Proof: 60 MB of gzip
  that inflates past it is refused.

### Retrievers

Trust boundary: queries come from users, and documents may hold text written to steer a model.
- Tokenizing is one linear regular expression, with no backtracking on hostile input.
- Filters compare values; they never become code or a query language.
- A model reranker or query-variant generator reads documents and queries as data in its prompt. Its
  output is parsed as JSON and used only to order or widen a search, never to call a tool.

Findings: none.

### MCP registry

Trust boundary: the configuration file is trusted, since it names programs to run. What a server
says about itself is not: its tool names, its descriptions, and its results.
- A server's tools are prefixed with its name by default, so one server cannot shadow another's
  tool.
- Allow and deny lists limit what agents see, and deny wins.
- A tool from a server declares no capabilities. A permission policy denies such a tool unless its
  `undeclared` rule says otherwise, and `humanApproval()` asks about it by default.
- `${NAME}` placeholders keep credentials out of the file. A missing variable is named in the error,
  never its value.

Finding, fixed in 2.4: **a local server inherited this process's whole environment.** Any
`npx`-started server, which is usually third-party code, saw every API key and database URL the
application held. A server now starts with `env` and only what a process needs to run: the path,
the home and temporary directories, the locale, proxies, and certificates. The new `inheritEnv`
option widens this by name, or entirely. Proof: a real child process started by the transport sees
the variables it was given, and not a secret set in the parent.

### Context hub

Trust boundary: an imported bundle may come from another team or another organization. Who may
commit and promote is the application's access control, which the studio's roles enforce.
- An import recomputes each bundle's and each prompt's content version, and refuses one whose content
  changed after export.
- A bundle names tools, but `bindTools()` binds only implementations the application supplies, so
  a bundle cannot add code.
- Promotion runs the label's gates, an experiment over the exact version among them.
- Labels move by compare-and-set, so a promotion decided on a stale version is refused.

Finding, fixed in 2.4: **the file store's compare-and-set could lose a move.** Two label moves at
once in one process could both pass the check, and the later write erased the earlier one. Label
writes to one file are now serialized across the process. Proof: two hubs whose writes are held
until both arrive race for one label on every backend, and on the file store the earlier code
loses a move every time. Several processes promoting the same label at once still need the Redis or
Postgres store, as the prompts guide says.

### Insights

Trust boundary: runs and their errors carry user data, and a model proposes fixes.
- An error signature replaces numbers, quoted values, URLs, ids, and long hexadecimal strings, so a
  cluster's summary does not carry a customer's data.
- A model's proposed fix is parsed as data, evaluated on a dataset, and never applied without a
  person. A promotion still runs the label's gates.
- A proposal id is checked against a strict pattern before it becomes a file name.

Findings: none.

### Tenant limits and the worker queue

Trust boundary: a tenant is whoever the application's `authenticate()` says, never a header the
server trusts by itself.
- Concurrency, rate, and budget limits are kept in a shared store, so several replicas enforce one
  limit. Admission and release are tested by ten racing workers.
- A run is released exactly once, however it ends.
- The queue claims an operation under a lease in one atomic step on every store. A lost lease
  cancels the run's signal, and a crash at any durable boundary resumes to the same state.

Findings: none.

### Deployments

Reviewed for 2.4, and again for 2.5, when it graduated.

Trust boundary: a deployment is changed by an admin, a canary guard, or the studio's admins; a run
names its assistant, and optionally a revision, in a request from any caller with the write scope.
Replicas, guards, and the studio share the server's state store, which they trust.
- Every change is decided on the version it read and written by compare-and-set, on every included
  state store, so a stale change never overwrites a newer one.
- A guard acts on the version it judged, so guards on every replica never undo each other.
- A replica writes rollups only to its own record. Counts are as trustworthy as the state store, as
  run records already are.

Findings:
- **Fixed in 2.4: one caller's ratings could decide a canary.** A canary was judged on feedback
  entries, not on runs. A hundred low ratings of one run met the minimum sample alone, and could
  roll back a canary for everyone, or keep a bad one alive. Each run now counts once per feedback
  key, as the mean of its ratings.
- **Fixed in 2.4: two changes at once on one replica could lose one**, such as a guard's rollback
  and an operator's promotion. Changes to one deployment now apply in order.
- **Fixed in 2.5: two replicas changing one deployment in the same instant could lose one change.**
  The state store gained `putIfVersion()`, and a replica that loses the race decides again on the
  winner's record. Proof: ten replicas held until all arrive make mixed changes on every store, and
  every change lands in one linear history.
- **Fixed in 2.5: a name from a request could reach an object's prototype.** A run for the assistant
  `constructor`, or naming the revision `constructor`, was accepted and failed when it ran. Only an
  application's own assistants and revisions are looked up now, and both are refused with `400`.
- **Documented limitation: `fnv1a-v1` spreads sequential ids unevenly.** It stays the default, since
  its positions are part of the stability promise. `hash-v2` spreads them evenly, opt-in per
  deployment.
- **Documented limitation: a replica that dies loses the runs it counted in its last `rollupMs`.**
  Rollups are statistics; the run records stay whole.

### The studio and its accounts

Reviewed for 2.5, when it graduated.

Trust boundary: anyone who can reach the port, before signing in; a signed-in person, limited by
their role; a page on another site acting through a signed-in person's browser; and the data the
studio shows, which traces, models, and people wrote.
- The `Host` header must be a loopback name or one in `allowedHosts`, which closes DNS rebinding.
- Tokens are compared in constant time. A token in the URL is moved into an HTTP-only, `SameSite=Strict`
  cookie, `Secure` over HTTPS, and taken out of the address bar. `headerAuth()` trusts identity
  headers only with the proxy's secret or from its addresses.
- Every change needs a page token in a header, an HMAC of the user and their role under the server's
  secret, which another site can neither read nor send. Every refusal is audited.
- Every response carries a content security policy without inline script, `nosniff`, `no-store`,
  and no referrer. The page inserts every value as text.

Findings, each fixed in 2.5 with a test in `studio/test/security.test.ts`:
- **A request body was read whole before anyone signed in.** Anyone who could reach the port could
  fill the server's memory. A body past `maxBodyBytes`, 1 MiB by default, is now refused with `413`
  as it arrives.
- **Behind a sign-in proxy that uses Basic authentication, another site could make a change.** Any
  `Authorization` header counted as proof that a script, not a browser, sent the change. But a
  browser attaches Basic credentials to another site's request by itself. Only a bearer token counts
  now, and a change's body must be `application/json`, which a form on another site cannot send.
- **A change refused for want of the page token was not audited.** It is now, under the person whose
  browser sent it, so a forged change leaves a trace.
- **A name from the URL could reach an object's prototype.** A graph or review queue named
  `constructor` failed with a server error. Only an application's own entries are looked up.
- **A body that was not a JSON object reached handlers that read its fields.** `null`, an array, or a
  number failed with a server error. Such a body is now refused with `400`.
- **A path with malformed percent-encoding failed with a server error.** It is now a `400`.
- **A viewer could ask a store for everything it holds.** `limit`, `hours`, and `days` had no
  ceiling. A list now returns at most 1,000 items, the audit log 10,000 entries, the issues view 90
  days, and the costs view 366 days; past that, the request is refused with `400`.
- **The memory journal kept every comment.** It now keeps the latest 10,000, as it keeps audit entries.
- **The server answered an internal error with its message.** That reply could reach anyone who can
  reach the port. It now says only that the request failed, and logs the error on the server.
- **A proposal's pull-request link was rendered as stored.** The content security policy already
  blocked a `javascript:` address. Only `http` and `https` links are rendered now.

Documented limitations, which the studio guide states:
- The studio has no tenants of its own. Every account sees every source the studio is given, so a
  tenant's people get a studio over that tenant's `tenantScope()` views.
- A page token stays valid while the secret, the user, and their role do. Rotate `secret` to revoke
  every page at once.
- Someone without a session who opens another person's personal link is signed in as that person.
  The page shows who is signed in.
- `FileStudioJournal` reads its whole file for each listing, so rotate a long-lived one.
- The playground spends model budget, which is why it needs the editor role.

The fuzzing behind these: every route called by every role, and over 2,000 requests with hostile
paths, queries, and bodies. Each must answer below `500`, and no prototype may be polluted.
