# The command line

<!-- covers:  -->

The `nexus` command ships with the package. It is a thin layer over the library — scanning files, listing models, running and gating evaluations, reading traces, and printing the Postgres schema — and no library entry point imports it.

## CLI

The package installs a `nexus` command:

```bash
nexus scan src --json
nexus models --provider deepseek
nexus optimize prompt.txt --model gpt-5.4-mini --max-input-tokens 4000
nexus eval examples/cli-eval.json
nexus eval run eval.mjs --out candidate.json --baseline baseline.json --fail-on-regression
nexus traces list --store runs.jsonl --status error --since 2026-09-20T00:00:00Z
nexus db sql --adapters operations,traces | psql "$DATABASE_URL"
```

CLI commands are intentionally thin wrappers around library modules:

- `nexus scan` checks files for secrets, PII, and prompt-injection patterns.
- `nexus models` lists the bundled model registry.
- `nexus eval` runs JSON or JS eval cases. `nexus eval run`, `compare`, and `gate` run an evaluation
  module to an experiment file and fail a build only on a regression beyond noise.
- `nexus traces list`, `show`, and `export` read a JSONL trace file, or any trace store a module
  exports — a Postgres store over your own pool, for instance.
- `nexus db sql` prints the Postgres schema for the adapters you use, for your own migration tooling.
- `nexus optimize` previews token optimization for a request or prompt file.

Every command takes `--json`. A usage mistake exits with 2 and a failed check with 1, so a CI script
can tell them apart. The newer commands load their code on demand, so `nexus scan` starts no slower.
