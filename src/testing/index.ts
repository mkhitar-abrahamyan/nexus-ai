/**
 * Conformance suites, on their own entry point: check a chat, embedding, or image provider adapter
 * against the neutral contract, against recordings in every pull request and live where credentials
 * are. Recording and replaying provider traffic is on `nexus-ai-pro/testing/record`.
 */
export {
  EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES,
  type EmbeddingProviderConformanceCase,
  type EmbeddingProviderConformanceOptions,
  type EmbeddingProviderConformanceResult,
  runEmbeddingProviderConformance,
} from './embedding-provider-conformance.js';
export {
  IMAGE_PROVIDER_CONFORMANCE_FIXTURES,
  type ImageEditProviderConformanceCase,
  type ImageGenerateProviderConformanceCase,
  type ImageProviderConformanceCase,
  type ImageProviderConformanceOptions,
  type ImageProviderConformanceResult,
  runImageProviderConformance,
} from './image-provider-conformance.js';
export {
  PROVIDER_CONFORMANCE_FIXTURES,
  type ProviderConformanceCase,
  type ProviderConformanceOptions,
  type ProviderConformanceResult,
  runProviderConformance,
} from './provider-conformance.js';
