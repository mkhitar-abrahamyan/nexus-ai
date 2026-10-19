# Adapter kit

<!-- covers: ./adapter-kit -->

How a package outside this repository builds an adapter and proves it works. An adapter can be:
- a chat provider;
- an embeddings backend;
- a vector store;
- a retriever;
- a long-term store.

Each `define*()` function takes four things:
- what the adapter is;
- the releases of `nexus-ai-pro` it supports;
- what it can do;
- how to create it.

It returns an `Adapter`. Every instance the adapter creates normalizes its failures into one
vocabulary and reports each call for telemetry. `verify()` runs the same contract suite this package
runs on its own adapters, plus a small benchmark held to the budgets the adapter declares.

```ts
import { defineVectorStoreAdapter } from 'nexus-ai-pro/adapter-kit';

export const milvus = defineVectorStoreAdapter({
  name: '@acme/nexus-milvus',
  version: '0.3.0',
  nexus: '>=2.4.0 <3',
  capabilities: { filters: 'typed', minScore: true },
  create: (config: MilvusConfig) => new MilvusVectorStore(config),
  normalizeError: (error) => ((error as { code?: string }).code === 'QUOTA' ? { code: 'RATE_LIMIT', retryable: true } : undefined),
  budgets: { search: 150 },
});

// In the adapter's own test suite, against a real or a containerized server:
const report = await milvus.verify(config, { embed });
if (!report.passed) throw new Error(JSON.stringify(report.checks.filter((check) => !check.ok)));
```

## Defining an adapter

| Kind | Builder | Contract | `verify()` options |
| --- | --- | --- | --- |
| A chat provider, extending `BaseProvider` | `defineProviderAdapter()` | Completion, streaming, JSON output, tool calls, health | `ProviderVerifyOptions`: the model and any cases of your own |
| An embeddings backend | `defineEmbeddingsAdapter()` | One vector per input, in order, of one width; abort; determinism | `EmbeddingsVerifyOptions` |
| A `VectorStore` | `defineVectorStoreAdapter()` | `runVectorStoreContract()` | `VectorStoreVerifyOptions`: the embedding function, and a `settle` for an eventually consistent index |
| A `Retriever` or `SparseRetriever` | `defineRetrieverAdapter()` | `runRetrieverContract()` | `RetrieverVerifyOptions`: a `load` for a retriever that does not hold its own passages |
| A long-term `Store` | `defineStoreAdapter()` | `runStoreContract()` | none |

An `AdapterDefinition` names the adapter, its `version`, and `nexus`, the range of releases it
supports. That range reads as npm reads one: `>=2.4.0 <3`, `^2.4.0`, `~2.4.1`, `2.x`, and
alternatives joined by `||`. `satisfiesRange()` and `parseVersion()` are the same check, on their
own. `compatible()` asks it of any release, the installed one by default. `verify()` fails an adapter
whose range leaves out the release it runs against.

`capabilities` declares what the adapter can do, per kind:
- `ProviderAdapterCapabilities`: streaming, JSON output, tools, and a health check;
- `EmbeddingsAdapterCapabilities`: abort and determinism;
- `VectorStoreCapabilities`: `searchVector`, `minScore`, and filters (`none`, `exact`, or `typed`,
  which also tells `3` from `'3'`);
- `RetrieverCapabilities`: whether it takes writes, and filters;
- `StoreCapabilities`: search, filters, and namespace listing.

The contract skips a check the adapter declares it cannot pass, and reports it as skipped. A check it
claims and fails is a failure. `budgets` gives the p95 latency each operation must stay within in the
benchmark.

## What an instance guarantees

`create()` wraps the instance. Each operation of its kind is timed and reported to
`AdapterCreateOptions.onCall`: `search` and `add` for a vector store, `complete` for a provider, and
so on. That hook is where a tracer or a metrics exporter subscribes, with an `AdapterCallEvent` for
every call: the adapter, its `AdapterKind`, the operation, the duration, and how it failed if it did.

Every failure comes out as an `AdapterError`, whose `code` is an `AdapterErrorCode` (`AUTH`,
`RATE_LIMIT`, `NOT_FOUND`, `INVALID`, `CONFLICT`, `TIMEOUT`, `UNAVAILABLE`, `CANCELLED`, or
`UNKNOWN`), with `retryable` and the HTTP `status` when there was one. So code above any adapter
retries and alerts the same way. `classifyAdapterError()` reads a status, a network code such as
`ECONNREFUSED`, or an `AbortError`. An adapter's own `normalizeError` runs first, returning an
`AdapterErrorClass`, for a service with codes of its own. Methods the kit does not instrument, and
private fields, work as they always did.

## Verifying

`verify()` returns an `AdapterReport`:
- whether the adapter is `compatible`;
- whether it `passed`;
- every `AdapterCheck`: its name, whether it held, why not, or that it was skipped;
- the `benchmark`, an `AdapterBenchmarkEntry` per operation with the calls measured and the p50 and
  p95 latency.

The contracts also run on their own, against any instance, so an adapter can put them inside its
own test framework:
- `runVectorStoreContract()` checks, with `VectorStoreContractOptions`, against an empty store:
  - ranking and `topK`;
  - sources and metadata returned whole;
  - filters and typed filters;
  - `minScore`;
  - vector search;
  - replacement by id, deletes, an id added again after its delete, and empty writes.
- `runRetrieverContract()` checks exact terms, ranking, `topK`, filters, and an empty query, plus
  replacement and deletes for a `SparseRetriever`. `RetrieverContractOptions` gives the
  capabilities, the `load` that fills what a retriever without `add()` reads from, and a `settle`.
- `runStoreContract()` checks:
  - values round-trip;
  - a replaced item keeps its creation time;
  - a missing key reads as nothing;
  - deletes;
  - prefix search with filters and paging;
  - namespace listing.

Every contract runs on `ADAPTER_FIXTURE_PASSAGES`, so results compare across adapters. An
`AdapterReport` also carries what the adapter declared, its `nexusRange`, `capabilities`, and
`budgets`, and the `contractVersion` it ran.

## Compatibility records

A compatibility record is what `verify()` proved, kept as a document: which contract version the
adapter passed, against which release, how fast, on what runtime, sealed with a digest. An adapter's
own CI makes one; one page lists them; and before a release ships, every listed adapter is verified
against it again, so a contract change that would break one is caught first.

Each kind's contract is versioned in `ADAPTER_CONTRACTS`: an `AdapterContract` with its current
`version` and its `history`, each `AdapterContractVersion` naming the release it arrived in and the
checks it `added`. The vector-store contract is at version 2, which 2.15 made by adding “adds a
passage again under an id it deleted”, a check a store that marks deletes and never clears the mark
fails. Contract checks are added in a minor release only when they test something the contract
already promised.

The command line makes records from the adapter's own repository, against the installed package:

```bash
# verify.mjs exports { adapter, config, options, record, close }: the adapter, what its verify() takes,
# record options such as its repository, and anything to close after.
npx nexus adapters verify ./verify.mjs --out records/milvus.json --package @acme/nexus-milvus@0.3.0
npx nexus adapters page records --out COMPATIBILITY.md --check
npx nexus adapters recheck records
```

- `nexus adapters verify` loads the module, runs the adapter's `record()`, prints each check, writes
  the record, and exits 1 when the adapter does not pass. `config` and `options` may be functions,
  for a server started first. The record names the module as `verify`, relative to the record, or as
  `--verify` says, such as a package export `@acme/nexus-milvus/verify`, so it can be run again.
- `nexus adapters page` lists records, files or directories of them, as Markdown, or HTML with
  `--html`. `--check` exits 1 on a record that is failing or outside the installed release's range,
  `--strict` on a stale one too, and `--expect` on a page that does not list the records as they are.
- `nexus adapters recheck` verifies each listed adapter again against the installed release, prints
  what it finds, and exits 1 when an adapter that passed its record no longer does, naming each check
  that broke and each new check it fails. `--out` writes the new records; `--update` writes them over
  the listed ones.

In code, `adapter.record()` verifies and seals in one step, and `compatibilityRecord()` seals an
`AdapterReport` with `CompatibilityRecordOptions`: the `package`, the `repository`, the `verify`
module, a `runtime`, and a clock. A `CompatibilityRecord` of format `COMPATIBILITY_RECORD_FORMAT`
(`nexus-compatibility/1`) holds its `CompatibilityRecordAdapter` (name, version, kind, range,
capabilities, budgets, and where it lives), the contract, the release, when, where, its checks, its
benchmark, and its `digest`, which `recordDigest()` computes over everything else.
`readCompatibilityRecord()` reads one back and throws a `CompatibilityRecordError` listing its
`issues`: an unknown format, a missing field, or a digest that does not match an edit.

`recordStatus()` returns a record's `CompatibilityStatus` against a release: its
`CompatibilityState`, `passing`, `failing`, `incompatible` (the release is outside the declared
range), or `stale` (verified against an older contract version), the reasons, and the checks it has
not been verified for. `compareRecords()` returns a `CompatibilityComparison` of a listed record and a
new one: each `CheckChange` that broke, the checks added since, those fixed, the operations whose p95
more than doubled, and whether the new record `regressed`. `compatibilityPage()` writes the page, by
kind and name, with `CompatibilityPageOptions`: a `title`, an `intro`, the release to judge by, and
`markdown` or `html`. The same records make the same page.

This repository's own page, [COMPATIBILITY.md](../COMPATIBILITY.md), lists records of the adapters it
ships, made the same way from `compatibility/adapters`, and every build verifies each one again. To
list an adapter of your own, open a pull request adding its record to `compatibility/records`, its
`verify` naming a module published in its package.

## Proof

A community adapter in a directory of its own, a vector store that marks a deleted id as gone and
never clears the mark, listed with a record that passed contract v1 when 2.14 was current. Verified
again by `nexus adapters recheck` against this release, whose contract v2 adds a check it does not
meet, its record turns red, naming the check, and the command exits 1; fixed, it passes, and its
new record replaces the old. The page shows the old record as stale, and refuses one edited after it
was sealed. In the clean-install test, the installed command records a community adapter from the
consumer project, verifies it again, and lists it.

The clean-install test builds an adapter the way an outside package would. It is a vector store
written in plain JavaScript inside the consumer project, importing nothing but
`nexus-ai-pro/adapter-kit` from the installed tarball, and it passes the full contract with typed
filters and a latency budget. Each kind's contract also runs against this package's own references.
A deliberately broken store fails exactly the checks it breaks.

## Limitations

- The provider and embeddings suites send real requests, so run them against the service or a
  local stand-in, not in a unit test without one.
- Credentials belong in the configuration passed to `create()` and `verify()`, never in the
  definition, which an adapter package publishes.
