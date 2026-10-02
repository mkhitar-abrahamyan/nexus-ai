# The command line

<!-- covers:  -->

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
| `nexus db sql` | Prints the Postgres schema for the adapters you use. |
| `nexus deploy` | Reads and changes an agent server's deployments over HTTP. |
| `nexus migrate` | Moves imports to the subpaths the 2.0 root import keeps them on. |

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
```

`--store` takes a JSONL file, or a module that exports a trace store as `{ store }`, such as a
Postgres store over your own pool. `nexus db sql` prints the schema rather than applying it, so it
needs no database driver and goes through your own migration tooling.

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

A second run changes nothing. Comments inside an import list that it splits are not kept. It works on
text, so an import statement inside a string is rewritten too. The
[migration guide](../MIGRATING.md) covers what 2.0 changes beyond imports.

## Exit codes

Every command takes `--json`. A usage mistake exits 2, and a failed check or a refused request exits
1, so a CI script can tell them apart. The newer commands load their code on demand, so `nexus scan`
starts no slower.

