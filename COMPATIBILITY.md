# Adapter compatibility

Every adapter recorded with `nexus adapters verify`: the contract it passed, against which release of nexus-ai-pro, how fast, and on what runtime. The adapters this repository ships are verified again against every build, so a contract change that would break one fails the build before it ships. Community adapters publish their records from their own CI, and are gathered daily onto the [community page](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/compatibility/README.md), as the [adapter kit guide](docs/adapter-kit.md#records-from-an-adapters-own-ci) describes.

States are judged against nexus-ai-pro 2.21.0.

| Adapter | Kind | Version | Verified against | Contract | State | Checks | p95 | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [nexus-ai-pro/rag/retrievers KeywordIndex](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/rag/retrievers.ts) | retriever | 2.x | 2.21.0 | v1 | passing | 9/9 | add 0.5 ms, delete 0.02 ms, retrieve 0.13 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/store MemoryStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/store/memory.ts) | store | 2.x | 2.21.0 | v1 | passing | 9/9 | delete 0.01 ms, get 0.03 ms, listNamespaces 0.04 ms, put 0.7 ms, search 0.11 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/rag MemoryVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/hallucination/retrieval.ts) | vector-store | 2.x | 2.21.0 | v2 | passing | 13/13 | add 0.31 ms, delete 0.02 ms, search 0.16 ms, searchVector 0.02 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/sqlite/vectors SqliteVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/sqlite/vectors.ts) | vector-store | 2.x | 2.21.0 | v2 | passing | 13/13 | add 0.49 ms, delete 0.08 ms, search 0.42 ms, searchVector 0.12 ms | 2026-10-26, node 24.22.1 win32 x64 |
