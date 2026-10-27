# Adapter compatibility, with the community

Every adapter recorded with `nexus adapters verify`: those nexus-ai-pro ships, verified again against every build, and community adapters, as their own CI last recorded them, gathered daily from the URL each package names. A community record is checked as it was sealed and must name its package; it is listed, never run. To be listed, publish your record from your CI as the adapter kit guide describes.

States are judged against nexus-ai-pro 2.21.0.

| Adapter | Kind | Version | Verified against | Contract | State | Checks | p95 | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [nexus-ai-pro/rag/retrievers KeywordIndex](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/rag/retrievers.ts) | retriever | 2.x | 2.21.0 | v1 | passing | 9/9 | add 0.5 ms, delete 0.02 ms, retrieve 0.13 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/store MemoryStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/store/memory.ts) | store | 2.x | 2.21.0 | v1 | passing | 9/9 | delete 0.01 ms, get 0.03 ms, listNamespaces 0.04 ms, put 0.7 ms, search 0.11 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/rag MemoryVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/hallucination/retrieval.ts) | vector-store | 2.x | 2.21.0 | v2 | passing | 13/13 | add 0.31 ms, delete 0.02 ms, search 0.16 ms, searchVector 0.02 ms | 2026-10-26, node 24.22.1 win32 x64 |
| [nexus-ai-pro/sqlite/vectors SqliteVectorStore](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/sqlite/vectors.ts) | vector-store | 2.x | 2.21.0 | v2 | passing | 13/13 | add 0.49 ms, delete 0.08 ms, search 0.42 ms, searchVector 0.12 ms | 2026-10-26, node 24.22.1 win32 x64 |
