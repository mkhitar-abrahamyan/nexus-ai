# Adapter compatibility

Every adapter recorded with `nexus adapters verify`: the contract it passed, against which release of nexus-ai-pro, how fast, and on what runtime. The adapters this repository ships are verified again against every build, so a contract change that would break one fails the build before it ships. Community adapters publish their records from their own CI, and are gathered daily onto the [community page](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/compatibility/README.md), as the [adapter kit guide](docs/adapter-kit.md#records-from-an-adapters-own-ci) describes.

States are judged against nexus-ai-pro 2.20.2.

| Adapter | Kind | Version | Verified against | Contract | State | Checks | p95 | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [nexus-ai-pro/rag/retrievers KeywordIndex](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/rag/retrievers.ts) | retriever | 2.x | 2.20.2 | v1 | passing | 9/9 | add 0.45 ms, delete 0.02 ms, retrieve 0.13 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/store MemoryStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/store/memory.ts) | store | 2.x | 2.20.2 | v1 | passing | 9/9 | delete 0.02 ms, get 0.04 ms, listNamespaces 0.04 ms, put 0.81 ms, search 0.12 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/rag MemoryVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/hallucination/retrieval.ts) | vector-store | 2.x | 2.20.2 | v2 | passing | 13/13 | add 0.32 ms, delete 0.01 ms, search 0.17 ms, searchVector 0.02 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/sqlite/vectors SqliteVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/sqlite/vectors.ts) | vector-store | 2.x | 2.20.2 | v2 | passing | 13/13 | add 0.55 ms, delete 0.12 ms, search 0.33 ms, searchVector 0.1 ms | 2026-10-26, node 24.22.1 win32 x64 |
