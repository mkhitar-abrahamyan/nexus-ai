/**
 * Prompt templates and content versions.
 *
 * The smallest part of the prompts family: define a prompt, render it, and compute the version a
 * registry would give it. Serving is `nexus-ai-pro/prompts/client`; committing, promoting, and
 * evaluating are `nexus-ai-pro/prompts/registry`.
 */
export {
  PromptConflictError,
  PromptDefinitionError,
  PromptError,
  PromptNotFoundError,
  PromptPromotionError,
  PromptRenderError,
  type GateResult,
} from './errors.js';
export {
  type CompiledMessage,
  type CompiledPrompt,
  compilePrompt,
  definePrompt,
  type Prompt,
  type PromptInput,
  type PromptSpec,
  renderCompiled,
  type TemplateVariables,
} from './template.js';
export { chooseVariant } from './variant.js';
export { canonicalJson, promptVersion } from './version.js';
export type {
  PlaceholderMessages,
  PromptDefinition,
  PromptHistoryAction,
  PromptHistoryEntry,
  PromptLabel,
  PromptMessage,
  PromptMessagePlaceholder,
  PromptMessageTemplate,
  PromptModelConfig,
  PromptReference,
  PromptStore,
  PromptVariant,
  PromptVersion,
  RenderedPrompt,
  RenderOptions,
} from '../types/prompts.js';
