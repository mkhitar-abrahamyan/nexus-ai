# The command line

<!-- covers: ./doctor -->

The package installs a `nexus` command. It is a thin layer over the library, for the terminal and for
CI scripts. No library entry point imports it.

```bash
nexus scan src --json
nexus eval run eval.mjs --out candidate.json --baseline baseline.json --fail-on-regression
nexus traces list --store runs.jsonl --status error --since 2026-09-20T00:00:00Z
nexus deploy canary support 2026-09-30 10 --url https://agents.internal
```

## The commands

| Command | What it does |
| --- | --- |
| `nexus scan` | Checks files for secrets, PII, and prompt-injection patterns. |
| `nexus models` | Lists the bundled model registry. |
| `nexus optimize` | Previews token optimization for a request or a prompt file. |
| `nexus eval` | Runs JSON or JS eval cases. |
| `nexus eval run`, `compare`, `gate` | Run an evaluation module to an experiment file, compare two, and fail a build only on a regression beyond noise. |
| `nexus traces list`, `show`, `export` | Read a JSONL trace file, or any trace store a module exports. |
| `nexus db sql`, `status`, `migrate` | Print the Postgres schema, show which migrations a database has, and apply the rest. |
| `nexus deploy` | Reads and changes an agent server's deployments over HTTP. |
| `nexus migrate` | Moves imports to the subpaths the 2.0 root import keeps them on. |
| `nexus graph lint` | Checks a compiled graph's shape for designs that fail in production. |
| `nexus doctor` | Checks a deployment: runtime, credentials, database and migrations, Redis, the queue, the registry, health, and settings that only work in one process. |

`nexus help` prints every flag.

## Scanning, models, and optimization

```bash
nexus scan src --json
nexus models --provider deepseek
nexus optimize prompt.txt --model gpt-5.4-mini --max-input-tokens 4000
```

`nexus scan` exits 1 when it finds something, unless you pass `--no-fail`. It never prints a matched
value unless you ask with `--reveal-values`, in an interactive terminal.

## Evaluation

```bash
nexus eval examples/cli-eval.json
nexus eval run eval.mjs --out candidate.json --baseline baseline.json --fail-on-regression
nexus eval gate baseline.json candidate.json
```

- An eval file exports `{ cases, client }` or `{ cases, config }`. JSON cases may use `expected`,
  `contains`, and a `match` of `includes`, `exact`, or `regex`.
- A module for `eval run` exports `{ target, dataset, evaluators }`, and optionally a summary and options.
- `eval gate` exits 1 when a metric got worse beyond noise, a new failure appeared, or the datasets
  differ.

## Traces and the database

```bash
nexus traces list --store runs.jsonl --status error --since 2026-09-20T00:00:00Z
nexus traces show trace-123 --store store.mjs
nexus db sql --adapters operations,traces | psql "$DATABASE_URL"
nexus db status --client db.mjs --check
nexus db migrate --client db.mjs --dry-run
```

`--store` takes a JSONL file, or a module that exports a trace store as `{ store }`, such as a
Postgres store over your own pool. `nexus db sql` prints the schema rather than applying it, so it
needs no database driver and goes through your own migration tooling; `--record` adds the rows that
mark each migration applied.

`nexus db status` and `nexus db migrate` reach the database through a module you write, which exports
your own client, so the CLI still needs no driver:

```js
// db.mjs
import pg from 'pg';
export const client = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const close = () => client.end();
```

The module may also export `dialect` (`postgres` or `sqlite`, detected from the client otherwise), a
`transaction` function for Postgres (see the [Postgres guide](./postgres.md)), and `migrations`, a
list that replaces the bundled one, for stores on custom tables. `--adapters` narrows the bundled list
and `--table` renames the migrations table. `status` prints each migration as applied, pending,
changed, or written by a newer release, and with `--check` exits 1 while one is pending or changed,
which suits a deploy step. `migrate --dry-run` prints the statements it would run.

## Checking a deployment

`nexus doctor` runs every check it can and exits 1 when one fails, or with `--strict` when one warns:

| Check | Fails or warns when |
| --- | --- |
| Node.js | the version is older than 22 |
| Optional packages | never; lists which optional peers are installed |
| Provider credentials | no provider's API key is in the environment (warns; only names are printed, never values) |
| Model registry | the bundled registry is older than its window (warns) |
| Database | it cannot be reached |
| Schema migrations | a migration is pending or changed after it ran |
| Redis | `PING` fails |
| Operation queue | a running operation's lease lapsed, or the oldest queued one waited past `--max-queue-age-ms` (warns) |
| Provider health | a provider is stale or unhealthy (warns) |
| One-process settings | with more than one replica, a store keeps its state in process memory: a memory checkpointer, operation store, server state, or tenant usage fails; a memory rate-limit, circuit, trace, prompt, cache, or rollup store warns |

Without `--module` it checks what a shell can see. A module reaches the rest, exporting any of
`database` (or `client`, so a `nexus db` module works unchanged), `redis`, `operations`, `ai`,
`deployment` (`{ replicas, stores }`), and `close`. `--replicas` sets the replica count.

```bash
nexus doctor --module doctor.mjs --strict
```

`diagnose()`, on `nexus-ai-pro/doctor`, runs the same checks from code — at boot, or behind a health
endpoint. `DoctorOptions` takes each input, including a `DoctorDatabase` and a
`DoctorDeployment`, and it resolves to a `DoctorReport`: every `DoctorCheck` with its `DoctorStatus`
(`ok`, `warn`, `fail`, or `skip`), detail, and hint, and whether the deployment is `ok`. It never
throws: a check that cannot run is a failure with the reason, and anything heavy is loaded only when
its check runs.

## Deployments

`nexus deploy` talks to a running [agent server](./server.md). A pipeline uses it to move traffic
onto a new revision after it rolls out the image:

```bash
export NEXUS_SERVER_URL=https://agents.internal NEXUS_SERVER_TOKEN=…
nexus deploy canary support 2026-09-30 10 --reason "build 412"
nexus deploy status support
nexus deploy promote support 2026-09-30
nexus deploy rollback support
```

| Command | What it does |
| --- | --- |
| `deploy status [assistant]` | Every deployment, or one with its revisions' runs and its history. |
| `deploy canary <assistant> <revision> <percent>` | Gives a revision that share of new traffic. |
| `deploy promote <assistant> <revision>` | Makes a revision live, with all the traffic. |
| `deploy rollback <assistant> [--to revision]` | Pulls the canary, or undoes the last promotion. |

`--url` and `--token` override the environment variables. `--reason` is recorded in the history.
`--version` refuses the change when someone moved the deployment first. The server's admin scope
guards every one of these. See the [deployments guide](./deployments.md) for what they do.

## Migrating to 2.0

`nexus migrate` moves a 1.x codebase onto 2.0. Most of what changes is where names are imported
from: the 2.0 root keeps only the core client, so a family imported from the root moves to its
subpath.

```bash
npx nexus migrate src            # reports what would change
npx nexus migrate src --write    # rewrites the files
npx nexus migrate src --check    # exits 1 while anything is left
```

It reads TypeScript and JavaScript files, and the code blocks in Markdown. It skips `node_modules`,
build output, and version control.

| It rewrites | It reports, for you to finish |
| --- | --- |
| `import`, `import type`, and `export … from` of the root | A namespace import of the root |
| A destructured `require()` of the root | A dynamic `import()` or a whole `require()` of the root |
| A name that moved under another name, keeping your local name | A read of a response's `estimatedCost` |
| A removed alias, such as `ImageManagerConfig` | An option 2.0 removed, such as `projectId` or `latencyHalfLife` |
| | A model entry that still lists `modalities` |
| | A model name the 2.0 registry dropped, such as `deepseek/deepseek-chat`, with what to use instead |

A second run changes nothing. Comments inside an import list that it splits are not kept. It works on
text, so an import statement inside a string is rewritten too. The
[migration guide](../MIGRATING.md) covers what 2.0 changes beyond imports.

## Linting a graph

`nexus graph lint` loads a module and runs `lintGraph()` on the graph it exports: the export named
after `#`, or `graph`, or the default. The export can be a compiled graph or a description saved as
JSON.

```bash
npx nexus graph lint ./dist/billing.js#checkout --deployed
```

It prints each finding and its fix, and exits 1 when a finding is an error. `--strict` fails on
warnings too, `--deployed` treats the in-process checkpointer as an error, and `--ignore` skips codes,
such as `--ignore DYNAMIC_ROUTE`. The [graph guide](./graphs.md#linting-a-graph) lists every rule.

## Exit codes

Every command takes `--json`. A usage mistake exits 2, and a failed check or a refused request exits
1, so a CI script can tell them apart. The newer commands load their code on demand, so `nexus scan`
starts no slower.

## Limitations

- The doctor checks that a store is reachable, and its queue, but not how it is configured. It does
  not warn when a Redis operation store runs without its dispatch index, or a persistent trace store
  without incremental tracing. The [operations](./operations.md) and [tracing](./tracing.md) guides say
  when each is worth turning on.


<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/doctor`

| Export | Kind | Summary |
| --- | --- | --- |
| `diagnose` | function | Runs every check its options allow and reports each, never throwing: a check that cannot run is a failure with the reason. |
| `DoctorCheck` | interface | One check's result. |
| `DoctorDatabase` | interface | A database for the doctor to reach, as `nexus db` reaches one. |
| `DoctorDeployment` | interface | What the doctor knows about how the application is deployed. |
| `DoctorOptions` | interface | What `diagnose()` checks. |
| `DoctorReport` | interface | Every check's result, and whether the deployment can run. |
| `DoctorStatus` | type | How one check came out: `fail` breaks the deployment, `warn` needs a look, `skip` had nothing to check. |
<!-- reference:end -->
