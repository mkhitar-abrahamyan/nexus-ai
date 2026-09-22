import type { EvaluateOptions } from '../evaluate/run.js';
import type { Dataset, DatasetExample, Evaluator, Experiment } from '../types/evaluate.js';
import type { CompletionRequest } from '../types/messages.js';
import type { PromptDefinition, PromptVersion, RenderOptions } from '../types/prompts.js';
import type { NexusResponse } from '../types/response.js';
import { compilePrompt, renderCompiled } from './template.js';
import { promptVersion } from './version.js';

/** Options for `evaluatePrompt()`: everything `evaluate()` takes, plus the model client and how inputs become variables. */
export interface EvaluatePromptOptions extends EvaluateOptions {
  /** Runs each rendered request. */
  client: { complete(request: CompletionRequest): Promise<NexusResponse> };
  /** Turns an example's inputs into template variables. Defaults to the inputs themselves, or `{ input }` for a non-object. */
  variables?: (inputs: unknown, example: DatasetExample) => Record<string, unknown>;
  /** Render options, such as a model override for comparing models on one prompt. */
  render?: RenderOptions;
}

/**
 * Runs a prompt version over a dataset and scores it: the headless playground.
 *
 * The experiment records the prompt's name and content version in `metadata.prompt`, which is what
 * `experimentGate()` looks for, so an experiment run here is what unlocks the promotion of the exact
 * version it ran. A prompt defined in code gets the same version it would get when committed.
 */
export async function evaluatePrompt<I = unknown, O = unknown>(
  prompt: PromptVersion | PromptDefinition | { definition: PromptDefinition },
  dataset: Dataset<I, O>,
  evaluators: Array<Evaluator<I, O>>,
  options: EvaluatePromptOptions,
): Promise<Experiment> {
  const definition: PromptDefinition = 'definition' in prompt ? prompt.definition : prompt;
  const version =
    'version' in prompt && typeof prompt.version === 'string' ? prompt.version : await promptVersion(definition);
  const compiled = compilePrompt(definition);
  const reference = { name: definition.name, version };
  const toVariables =
    options.variables ??
    ((inputs: unknown) =>
      inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs)
        ? (inputs as Record<string, unknown>)
        : { input: inputs });

  const { evaluate } = await import('../evaluate/run.js');
  const { client, variables: _variables, render, ...rest } = options;
  return evaluate<I, O>(
    async (inputs, context) => {
      const request = renderCompiled(
        compiled,
        definition,
        toVariables(inputs, context.example as DatasetExample),
        reference,
        render,
      );
      return client.complete(context.signal ? { ...request, signal: context.signal } : request);
    },
    dataset,
    evaluators,
    {
      name: `${definition.name}@${version}`,
      ...rest,
      metadata: { ...rest.metadata, prompt: reference },
    },
  );
}
