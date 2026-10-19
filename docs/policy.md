# Policy

<!-- covers: ./policy -->

What each tenant may reach, its guardrails, routing, budgets, regions, and credentials, as one
versioned file the application supplies: validated when the client starts, compared with the version
before it by `nexus policy check` in CI, and recorded on every operation it decides. A change that
lets a tenant reach more is reviewed like code, and acknowledged where the reviewer reads it.

```json
{
  "name": "production",
  "version": "7",
  "guardrails": { "preset": "enterprise" },
  "routing": {
    "denyModels": ["gpt-4o-mini"],
    "tenants": { "initech": { "allowModels": ["gpt-5*"] }, "globex": { "denyProviders": ["anthropic"] } }
  },
  "budgets": { "period": "month", "default": 100, "tenants": { "acme": 2000 } },
  "residency": {
    "regions": {
      "eu-west": { "providers": ["openai-eu", "mistral"], "twins": { "openai": "openai-eu" } },
      "us-east": { "providers": ["openai", "anthropic"] }
    },
    "tenants": { "acme": "eu-west", "globex": "any", "initech": ["us-east"] },
    "unassigned": "refuse"
  },
  "credentials": { "secretName": "tenants/{tenant}/{provider}" }
}
```

```ts
import { readFile } from 'node:fs/promises';
import { awsSecrets } from 'nexus-ai-pro/credentials';
import { applyPolicy, parsePolicy } from 'nexus-ai-pro/policy';

// Throws a PolicyError naming every issue, so a bad policy fails here, not on a request.
const policy = parsePolicy(await readFile('policy.json', 'utf8'));
const ai = new NexusAI(applyPolicy({ providers }, policy, { secrets: awsSecrets(client) }));
```

## The document

A `PolicyDocument` is plain JSON. Only its `name` and `version` are required; a section it leaves out
leaves the client's own setting in place.

- `guardrails`: the client's `security` settings, as `SecurityConfig`: a `preset`, a `level`, and the
  input and output settings.
- `routing`, a `PolicyRouting`: which providers and models may serve, for every tenant, and in
  `tenants`, for each one. Each is a `PolicyAccess`: `allowProviders` and `allowModels`, where only
  what is listed may serve, and `denyProviders` and `denyModels`, which never do. An entry matches a
  name equal to it, and `*` in it matches anything, as `gpt-5*` or `openai*`. An empty allow list is
  refused as a mistake: leave it out to admit any, or deny `*` to admit none.
- `budgets`, a `PolicyBudgets`: what each tenant may spend in US dollars per `period` (`hour`, `day`,
  `week`, or `month`, the default), with a `default` for a tenant with none of its own and for
  operations with no tenant.
- `residency`, a `PolicyResidency`: its `regions`, each tenant's rule in `tenants`, and the
  `unassigned` and `untenanted` rules, as `residency()` takes them in the
  [regions guide](./regions.md#residency).
- `credentials`, a `PolicyCredentials`: where each tenant's provider keys are read, the secret's name
  as `secretName` with `{tenant}` and `{provider}` filled in (`{tenant}/{provider}` by default), what
  `missing` does for a tenant with no secret (`refuse`, or `config` for the provider's configured
  key), and `cacheMs`, `missingCacheMs`, and `staleMs`, as `tenantCredentials()` takes them.
- `acknowledged`: the changes this version makes that a reviewer has accepted, as below.

## Validated when the client starts

`parsePolicy()` reads the document, as JSON text or as an object, and returns a `Policy`: its `name`,
`version`, and `hash`, the document, and the `reference` each operation records. A document that is
not valid throws a `PolicyError` whose `issues` list every `PolicyIssue`, each a `path` and a
`message`: a section or a routing rule it does not know, a region a rule names but no region defines,
a provider listed in two regions, a level or a preset that does not exist, a negative budget, an empty
allow list.

`policyHash()` is the SHA-256 of the content with every object's keys in order, so formatting and key
order never change it and any value does: two files that claim one version are told apart.

## Applied to a client

`applyPolicy()` returns the client's configuration under the policy. Its guardrails go over the
client's `security` settings, keeping the level the client set when the policy sets none. In
`lifecycle`, its residency becomes the residency policy, its credentials a `tenantCredentials()`
resolver over the `secrets` of `ApplyPolicyOptions`, its budgets a budget ledger, kept in `budgetStore`
when every replica should share them, and its routing a `ProviderGate` built by `providerGate()`. A
policy with a `credentials` section and no `secrets` throws a `PolicyError`. Its global model rules
are given to routing as well, so the router chooses among the models the policy admits; a client's own
allow list is kept, and the gate still holds the policy's.

`LifecycleConfig.providers` takes any `ProviderGate`: a `check()` that returns `true` for a provider,
and model when one is named, an operation may reach, or why not. It is checked wherever residency is.
A provider it refuses is refused with an `OperationDeniedError` naming the rule and the policy, such
as `provider openai is denied by routing.tenants.globex.denyProviders (policy production@7)`, before
anything is sent, and audited as `blocked`; a completion's attempt it refuses is dropped from the
route, as one outside the tenant's regions is, and an embedding never falls back to a model it
refuses. Model rules apply to every family the gate sees, so a tenant held to `gpt-5*` embeds with
nothing else either. A residency refusal under a policy names it too: `(tenant acme: eu-west; policy
production@7)`.

`LifecycleConfig.policy` takes the `PolicyReference`, its name, version, and hash, and every operation
records it, as `OperationDescriptor.policy` and on each of its `AuditLogEvent`s as `policy`, so an
audit answers which version of the policy allowed a call. `ai.lifecycle.access()` returns the
`CallResidency` an operation for a tenant would get, for code that decides outside one, and its
`refusal()` says why a call to a provider would be refused once placed on its twin.

## Reviewed in CI

`nexus policy check` validates a policy file, and, given `--base`, compares it with the version it
replaces, a file or `git:<ref>` for the same file at a commit:

```bash
npx nexus policy check policy.json --base git:origin/main
```

```text
Policy production@8 (sha256 4be1c09a7f31) is valid. Compared with production@7 from git:origin/main:
kind      path                    review            summary
--------  ----------------------  ----------------  ------------------------------------------------------------------
narrowed  budgets.tenants.acme                      budgets.tenants.acme lowered: 2000 to 1500
widened   residency.tenants.acme  NOT ACKNOWLEDGED  residency.tenants.acme may now reach us-east: eu-west before, eu-west, us-east now

1 change needs acknowledging: add "residency.tenants.acme" to "acknowledged" in policy.json, or pass --accept residency.tenants.acme.
```

`comparePolicies()` lists each `PolicyChange`: its `path`, its `kind`, a `PolicyChangeKind`, the
values `before` and `after`, and a `summary`.

| Kind | Changes |
| --- | --- |
| `widened` | A tenant's rule gains a region or becomes `any`, as do `unassigned` and `untenanted`; a region gains a provider or a twin; an allow list admits a name no entry before it did, or goes; a deny list lifts a name; a budget rises or goes; the guardrails' level falls, or the section goes; a tenant with no key gets the shared one. |
| `narrowed` | The reverse of each. |
| `changed` | A tenant's home region moves within the same regions; a twin is replaced; other guardrail or credential settings, the budget period, or the name change. |

`checkPolicyChange()` returns a `PolicyCheck`: every change, those `unacknowledged`, whether the
content changed while the version did not (`versionUnchanged`), and `ok`. A widened or changed
change must be acknowledged, by its path or a section above it (`residency` covers
`residency.tenants.acme`), in the new version's `acknowledged`, where the reviewer reads it, or with
`accept`, `--accept` on the command line. A narrowed one never needs to be. The command exits 1 when
the policy is not valid, a change is not acknowledged, or the content changed without a new version,
and prints the check as JSON with `--json`. A file the base commit does not have has nothing to compare
and passes once valid. In a CI checkout, fetch the base branch, as `fetch-depth: 0` does.

In the test suite, version 3 of a policy is committed, and version 4 lets an EU tenant reach the US as
well. `nexus policy check --base git:HEAD` fails, naming the tenant's rule; the client built from
version 4 does send that tenant's calls to the US, and from version 3 does not. Acknowledged in the
file, or accepted on the command line, the check passes; the same change without a new version fails
either way.

## Limitations

- The check compares documents, not clients: a setting the client makes beside the policy, or a
  section the policy leaves to the client, is not compared.
- Lists are compared entry by entry: an entry covered by one before it, as `gpt-5-mini` by `gpt-5*`,
  admits nothing new, but two lists that admit the same names written differently are a change.
- Tenants' regions are a map in the document. A rule that reads a tenant's record belongs in code,
  given to `residency()` directly.
- A budget is per tenant and period. A ledger keyed another way, or with a reservation lease of its
  own, is configured in code.
- `--base git:<ref>` reads the file at the same path; a file that moved has no base there.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/policy`

| Export | Kind | Summary |
| --- | --- | --- |
| `applyPolicy` | function | A client's configuration under a policy: its guardrails as the `security` settings, its global model rules on routing, and, in `lifecycle`, its residency, its credentials over `secrets`, its budgets as a ledger, a provider gate for its per-tenant routing rules, and the policy itself, which every operation then records. |
| `ApplyPolicyOptions` | interface | What `applyPolicy()` needs that a document cannot hold. |
| `checkPolicyChange` | function | Checks a new version of a policy against the one before: every change, which of them widen or need review without an acknowledgment, in the new document's `acknowledged` or `accept`, and whether the version moved with the content. |
| `comparePolicies` | function | Every change between two versions of a policy, each said to widen what a tenant may reach, narrow it, or change it otherwise: a region a tenant gains, a provider or twin a region gains, an allow list grown or a deny list shrunk, a budget raised, guardrails lowered, or a tenant's missing key falling back to the shared one all widen; a home region moved, a guardrail setting changed, or the name changed need review. |
| `parsePolicy` | function | Reads and validates a policy document: its JSON text, or the document itself. |
| `Policy` | interface | A validated policy, with what each operation records of it. |
| `PolicyAccess` | interface | Which providers and models may serve: allow lists, where only what is listed may, and deny lists. |
| `PolicyBudgets` | interface | A policy's budgets, in US dollars per period. |
| `PolicyChange` | interface | One change between two versions of a policy. |
| `PolicyChangeKind` | type | How a change moves what tenants may reach. |
| `PolicyCheck` | interface | What `checkPolicyChange()` found. |
| `PolicyCredentials` | interface | Where each tenant's provider keys are read, as `tenantCredentials()` takes it. |
| `PolicyDocument` | interface | A policy as its file holds it: plain JSON, every section optional but the name and the version. |
| `PolicyError` | class | Raised when a policy document is not valid, with every issue found. |
| `policyHash` | function | The SHA-256 of a policy's content, with its keys in order, so formatting never changes it. |
| `PolicyIssue` | interface | One thing wrong with a policy document, at its path. |
| `PolicyReference` | interface | A policy, as each operation it decides records it: its name, its version, and its content hash. |
| `PolicyResidency` | interface | A policy's residency: regions, what runs in each, and each tenant's regions, as `residency()` takes them. |
| `PolicyRouting` | interface | A policy's routing rules: for every tenant, and narrowed per tenant. |
| `providerGate` | function | A provider gate from a policy's routing rules: every tenant's first, then the operation's tenant's. |
| `ProviderGate` | interface | Which providers and models an operation may reach, beside residency: a policy's routing rules, per tenant. |
<!-- reference:end -->
