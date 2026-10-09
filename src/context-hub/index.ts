/**
 * The context hub: prompts, instructions, tool sets, and skills versioned together as context
 * bundles, promoted through evaluation gates, diffed, rolled back, and exported between projects.
 */
import { fingerprintOf } from '../evaluate/cache.js';
import type { EvaluateOptions } from '../evaluate/run.js';
import type { GateResult } from '../prompts/errors.js';
import { type ExperimentGateOptions, experimentVerdict } from '../prompts/gates.js';
import type { Dataset, DatasetExample, Evaluator, Experiment } from '../types/evaluate.js';
import type { ToolDefinition } from '../types/messages.js';
import type { ContextBundle, ContextPromotionContext, ContextPromotionGate, ContextReference } from './hub.js';

export { type ContextChange, type ContextDiff, diffContexts, formatContextDiff } from './diff.js';
export {
  type ContextBundle,
  type ContextBundleDefinition,
  type ContextBundleExport,
  ContextConflictError,
  ContextDefinitionError,
  type ContextHistoryEntry,
  ContextHub,
  ContextHubError,
  type ContextHubOptions,
  type ContextLabel,
  ContextNotFoundError,
  type ContextPromotionContext,
  ContextPromotionError,
  type ContextPromotionGate,
  ContextSignatureError,
  type ContextVerification,
  type ContextPromotionResult,
  type ContextPromptPin,
  type ContextReference,
  type ContextSkill,
  type ContextTool,
  contextVersion,
} from './hub.js';
export type { ExperimentGateOptions } from '../prompts/gates.js';
export {
  type ContextCryptoKey,
  type ContextJsonWebKey,
  type ContextKeyring,
  type ContextSignature,
  type ContextSignedContent,
  type ContextSigner,
  type ContextSigningKey,
  contextDigest,
  ed25519Keyring,
  ed25519Signer,
  generateContextKey,
} from './signing.js';

/**
 * A bundle's instructions joined into one system text, in the order the bundle lists them, or only
 * the ones named in `include`, in that order.
 */
export function contextInstructions(
  bundle: ContextBundle,
  options: { include?: readonly string[]; separator?: string } = {},
): string {
  const names = options.include ?? Object.keys(bundle.instructions ?? {});
  return names
    .map((name) => bundle.instructions?.[name])
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join(options.separator ?? '\n\n');
}

/**
 * A bundle's tools as tool definitions an agent can call: each definition from the bundle, each
 * implementation from your code, matched by name. A tool the bundle offers without an implementation
 * is an error, unless `strict` is false, when it is left out; an implementation the bundle does not
 * offer is never exposed, so the bundle decides what the model can call.
 */
export function bindTools(
  bundle: ContextBundle,
  implementations: Record<string, (args: Record<string, unknown>) => unknown>,
  options: { strict?: boolean } = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const tool of bundle.tools ?? []) {
    const execute = implementations[tool.name];
    if (!execute) {
      if (options.strict === false) continue;
      throw new RangeError(`Bundle "${bundle.name}" offers "${tool.name}", which has no implementation`);
    }
    tools.push({
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      execute: async (args: Record<string, unknown>) => execute(args),
    } as ToolDefinition);
  }
  return tools;
}

/** Runs one example with a bundle: build the request from it, call the model or agent, return the output. */
export type ContextTarget<I = unknown> = (
  bundle: ContextBundle,
  inputs: I,
  context: { example: DatasetExample<I>; run: number; signal?: AbortSignal },
) => Promise<unknown> | unknown;

/**
 * Runs a bundle version over a dataset and scores it. The experiment records the bundle in
 * `metadata.context`, which `contextExperimentGate()` looks for; with a `cache` and no `fingerprint`,
 * the fingerprint is the bundle's version, so an unchanged bundle re-scores its stored outputs.
 */
export async function evaluateContext<I = unknown, O = unknown>(
  bundle: ContextBundle,
  dataset: Dataset<I, O>,
  evaluators: Array<Evaluator<I, O>>,
  target: ContextTarget<I>,
  options: EvaluateOptions = {},
): Promise<Experiment> {
  const reference: ContextReference = { name: bundle.name, version: bundle.version };
  const { evaluate } = await import('../evaluate/run.js');
  return evaluate<I, O>((inputs, context) => target(bundle, inputs, context), dataset, evaluators, {
    name: `${bundle.name}@${bundle.version}`,
    ...options,
    ...(options.cache && !options.fingerprint ? { fingerprint: await fingerprintOf({ context: reference }) } : {}),
    metadata: { ...options.metadata, context: reference },
  });
}

function contextOf(experiment: Experiment): ContextReference | undefined {
  const context = experiment.metadata?.context as ContextReference | undefined;
  return context && typeof context === 'object' ? context : undefined;
}

/**
 * Refuses a promotion until an experiment has passed for the exact bundle version being promoted, as
 * `experimentGate()` does for prompts: an experiment counts when its `metadata.context` names the
 * version, which `evaluateContext()` records. `thresholds`, `maxErrors`, and `noRegression` work the
 * same way.
 */
export function contextExperimentGate(options: ExperimentGateOptions): ContextPromotionGate {
  return (context: ContextPromotionContext): Promise<GateResult> =>
    experimentVerdict(options, contextOf, context.name, context.bundle.version, context.current?.version);
}

/** Refuses a promotion unless the version is what another label serves now, such as `staging` before `production`. */
export function servedByContextGate(label: string): ContextPromotionGate {
  const gate = `served-by-${label}`;
  return async (context: ContextPromotionContext): Promise<GateResult> => {
    const pointer = await context.hub.store.getLabel(context.name, label);
    return pointer?.version === context.bundle.version
      ? { gate, ok: true }
      : { gate, ok: false, reason: `${context.bundle.version} is not what "${label}" serves` };
  };
}
