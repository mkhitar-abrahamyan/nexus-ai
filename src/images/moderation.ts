import type {
  AssetInput,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageResult,
  ImageSafetyContext,
  ImageSafetyPolicy,
  MediaSafetyFinding,
} from '../types/images.js';
import { ImageProviderError, ImageValidationError } from './errors.js';

export interface VisualModerationOptions {
  apiKey: string;
  baseUrl?: string;
  /** Defaults to `omni-moderation-latest`, which reads images as well as text. */
  model?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Score, 0–1, at or above which a category blocks. When omitted, the provider's own `flagged`
   * decision is used, which is the calibration it publishes.
   */
  blockThreshold?: number;
  /**
   * Score at or above which a category is sent for human review without blocking. Must be below
   * `blockThreshold`. Omitted means nothing is routed to review.
   */
  reviewThreshold?: number;
  /** Per-category overrides, for a category a product needs stricter or looser than the rest. */
  categoryThresholds?: Record<string, { block?: number; review?: number }>;
  inspectInput?: boolean;
  inspectOutput?: boolean;
  /**
   * Let content through when moderation itself fails. Defaults to false: an outage of the safety
   * check is not a reason to skip it, so an error blocks the request instead.
   */
  failOpen?: boolean;
}

interface ModerationResult {
  flagged?: boolean;
  categories?: Record<string, boolean>;
  category_scores?: Record<string, number>;
  category_applied_input_types?: Record<string, string[]>;
}

/**
 * Screens prompts, input images, and generated images through OpenAI's multimodal moderation.
 *
 * Text-only checks are insufficient for media: an innocuous prompt can yield an unsafe image, and an
 * uploaded reference can carry what the prompt never mentions. This inspects both sides of the call
 * and reports findings in the neutral `MediaSafetyFinding` shape, so it composes with any other
 * `ImageSafetyPolicy` through `combineSafetyPolicies`.
 */
export function createOpenAIVisualModeration(options: VisualModerationOptions): ImageSafetyPolicy {
  if (!options.apiKey?.trim()) throw new ImageValidationError('Visual moderation apiKey must not be empty');
  if (
    options.blockThreshold !== undefined &&
    options.reviewThreshold !== undefined &&
    options.reviewThreshold >= options.blockThreshold
  ) {
    throw new ImageValidationError('reviewThreshold must be below blockThreshold');
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = options.model ?? 'omni-moderation-latest';

  const moderate = async (
    parts: Array<Record<string, unknown>>,
    source: 'input' | 'output',
    assetIndex: number | undefined,
    signal: AbortSignal,
  ): Promise<MediaSafetyFinding[]> => {
    try {
      const response = await fetchImplementation(`${baseUrl}/moderations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: parts }),
        signal,
      });
      if (!response.ok) throw new ImageProviderError(`Moderation failed with HTTP ${response.status}`, 'openai');
      const body = (await response.json()) as { results?: ModerationResult[] };
      return (body.results ?? []).flatMap((result) => toFindings(result, source, assetIndex, options));
    } catch (error) {
      if (signal.aborted) throw error;
      if (options.failOpen) return [];
      return [
        {
          id: `moderation-unavailable-${source}-${assetIndex ?? 'prompt'}`,
          category: 'moderation-unavailable',
          severity: 'high',
          action: 'block',
          source,
          assetIndex,
          message: `Visual moderation could not run, so the content was blocked: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  };

  return {
    inspectInput:
      options.inspectInput === false
        ? undefined
        : async (request: ImageGenerateRequest | ImageEditRequest, context: ImageSafetyContext) => {
            const calls: Array<Promise<MediaSafetyFinding[]>> = [
              moderate([{ type: 'text', text: request.prompt }], 'input', undefined, context.signal),
            ];
            if ('input' in request) {
              // The mask is geometry, not content, so it is not screened.
              const images = [request.input, ...(request.references ?? [])];
              images.forEach((asset, index) => {
                const part = imagePart(asset);
                if (part) calls.push(moderate([part], 'input', index, context.signal));
              });
            }
            return (await Promise.all(calls)).flat();
          },
    inspectOutput:
      options.inspectOutput === false
        ? undefined
        : async (result: ImageResult, context: ImageSafetyContext) => {
            const calls = result.assets.map((asset, index) => {
              const part = imagePart(asset);
              if (part) return moderate([part], 'output', index, context.signal);
              return Promise.resolve<MediaSafetyFinding[]>([
                {
                  id: `moderation-uninspectable-${index}`,
                  category: 'uninspectable-asset',
                  severity: 'medium',
                  action: 'review',
                  source: 'output',
                  assetIndex: index,
                  message: 'A stored asset cannot be sent to moderation; it needs human review',
                },
              ]);
            });
            return (await Promise.all(calls)).flat();
          },
  };
}

function imagePart(asset: AssetInput): Record<string, unknown> | undefined {
  if (asset.location.kind === 'bytes') {
    const data = Buffer.from(asset.location.data).toString('base64');
    return { type: 'image_url', image_url: { url: `data:${asset.mimeType};base64,${data}` } };
  }
  if (asset.location.kind === 'url') return { type: 'image_url', image_url: { url: asset.location.url } };
  return undefined;
}

function toFindings(
  result: ModerationResult,
  source: 'input' | 'output',
  assetIndex: number | undefined,
  options: VisualModerationOptions,
): MediaSafetyFinding[] {
  const findings: MediaSafetyFinding[] = [];
  const scores = result.category_scores ?? {};

  for (const [category, score] of Object.entries(scores)) {
    const override = options.categoryThresholds?.[category];
    const block = override?.block ?? options.blockThreshold;
    const review = override?.review ?? options.reviewThreshold;
    const providerFlagged = result.categories?.[category] === true;

    const blocks = block === undefined ? providerFlagged : score >= block;
    const reviews = !blocks && review !== undefined && score >= review;
    if (!blocks && !reviews) continue;

    findings.push({
      id: `openai-visual-${source}-${assetIndex ?? 'prompt'}-${category}`,
      category,
      severity: score >= 0.9 ? 'critical' : score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low',
      action: blocks ? 'block' : 'review',
      source,
      confidence: score,
      assetIndex,
      metadata: { appliedInputTypes: result.category_applied_input_types?.[category] },
    });
  }
  return findings;
}

/**
 * Runs several safety policies and concatenates what they find.
 *
 * Every policy runs even after one blocks, so the finding list shows everything that was wrong
 * rather than stopping at the first problem.
 */
export function combineSafetyPolicies(...policies: ImageSafetyPolicy[]): ImageSafetyPolicy {
  const inputPolicies = policies.filter((policy) => policy.inspectInput);
  const outputPolicies = policies.filter((policy) => policy.inspectOutput);
  return {
    inspectInput:
      inputPolicies.length === 0
        ? undefined
        : async (request, context) =>
            (await Promise.all(inputPolicies.map((policy) => policy.inspectInput?.(request, context) ?? []))).flat(),
    inspectOutput:
      outputPolicies.length === 0
        ? undefined
        : async (result, context) =>
            (await Promise.all(outputPolicies.map((policy) => policy.inspectOutput?.(result, context) ?? []))).flat(),
  };
}
