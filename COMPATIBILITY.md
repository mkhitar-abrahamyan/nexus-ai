# Adapter compatibility

Every adapter recorded with `nexus adapters verify`: the contract it passed, against which release of nexus-ai-pro, how fast, and on what runtime. The adapters this repository ships are verified again against every build, so a contract change that would break one fails the build before it ships. To list an adapter of your own, add its record to `compatibility/records`, with the module that verifies it published in its package, as the [adapter kit guide](docs/adapter-kit.md#compatibility-records) describes.

States are judged against nexus-ai-pro 2.20.2.

| Adapter | Kind | Version | Verified against | Contract | State | Checks | p95 | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [nexus-ai-pro/rag/retrievers KeywordIndex](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/rag/retrievers.ts) | retriever | 2.x | 2.20.2 | v1 | passing | 9/9 | add 0.44 ms, delete 0.02 ms, retrieve 0.12 ms | 2026-10-24, node 24.22.1 win32 x64 |
| [nexus-ai-pro/store MemoryStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/store/memory.ts) | store | 2.x | 2.20.2 | v1 | passing | 9/9 | delete 0.01 ms, get 0.04 ms, listNamespaces 0.05 ms, put 0.75 ms, search 0.12 ms | 2026-10-24, node 24.22.1 win32 x64 |
| [nexus-ai-pro/rag MemoryVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/hallucination/retrieval.ts) | vector-store | 2.x | 2.20.2 | v2 | passing | 13/13 | add 0.3 ms, delete 0.01 ms, search 0.16 ms, searchVector 0.02 ms | 2026-10-24, node 24.22.1 win32 x64 |
| [nexus-ai-pro/sqlite/vectors SqliteVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/sqlite/vectors.ts) | vector-store | 2.x | 2.20.2 | v2 | passing | 13/13 | add 0.49 ms, delete 0.09 ms, search 0.3 ms, searchVector 0.08 ms | 2026-10-24, node 24.22.1 win32 x64 |
