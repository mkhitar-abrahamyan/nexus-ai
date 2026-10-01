/**
 * Grounding, on its own entry point: grounded prompts that cite their sources, and the checks that
 * catch an answer the evidence does not support. Retrieval itself — chunks, vector stores, and
 * ingestion — is on `nexus-ai-pro/rag`.
 */
export {
  type ConsistencyClient,
  completeWithSelfConsistency,
  type SelfConsistencyOptions,
  selectMostConsistent,
  textSimilarity,
} from './consistency.js';
export { asJsonOnly, type FactualOptions, withFactualDefaults } from './factual.js';
export {
  type KnowledgeGraph,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type KnowledgeGraphOptions,
  selectGraphFacts,
  withKnowledgeGraphContext,
} from './knowledge-graph.js';
export { extractCitations, type RagChunk, type RagOptions, validateCitations, withRagContext } from './rag.js';
export {
  completeVerified,
  extractFacts,
  lexicalEntailment,
  type NliVerifier,
  type VerificationClient,
  type VerificationFact,
  type VerificationOptions,
  type VerificationReport,
  verifyAgainstContext,
} from './verification.js';
