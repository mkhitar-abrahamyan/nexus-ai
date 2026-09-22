/**
 * The write side of the prompts family: commit versions, move labels, gate promotions, compare
 * versions, and evaluate a version over a dataset.
 *
 * Used by CI jobs and admin scripts. An application that only serves prompts needs
 * `nexus-ai-pro/prompts/client`, which is a fraction of the size.
 */
export {
  diffLines,
  diffPrompts,
  formatPromptDiff,
  type PromptDiff,
  type PromptFieldChange,
  type PromptLineChange,
  type PromptMessageDiff,
} from './diff.js';
export { type EvaluatePromptOptions, evaluatePrompt } from './evaluate.js';
export { type ExperimentGateOptions, experimentGate, servedByGate } from './gates.js';
export { MemoryPromptStore, type MemoryPromptStoreOptions } from './memory.js';
export {
  type PromotionContext,
  type PromotionGate,
  type PromotionResult,
  PromptRegistry,
  type PromptRegistryOptions,
  type PromptWebhookConfig,
  type ResolvedPrompt,
} from './registry.js';
export { deliverPromptWebhook, verifyPromptWebhook } from './webhooks.js';
