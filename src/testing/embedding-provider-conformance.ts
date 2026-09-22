import type {
  EmbeddingProviderCallContext,
  EmbeddingProviderRequest,
  EmbeddingProviderResult,
  EmbeddingsProvider,
} from '../types/embeddings.js';

/** One embeddings conformance case. */
export interface EmbeddingProviderConformanceCase {
  /** The case's name. */
  name: string;
  /** Texts to embed. */
  input: string[];
  /** Input type sent, such as `query` or `document`. */
  inputType?: EmbeddingProviderRequest['inputType'];
  /** Vector width requested. The result must match it. */
  dimensions?: number;
  /** An extra check on the result, beyond the contract. */
  validate?: (result: EmbeddingProviderResult) => boolean | Promise<boolean>;
}

/** The outcome of one embeddings conformance case. */
export interface EmbeddingProviderConformanceResult {
  /** The provider checked. */
  providerName: string;
  /** The model used. */
  model?: string;
  /** The case. */
  caseName: string;
  /** True when the result met the contract. */
  ok: boolean;
  /** Whether the adapter honored an already-aborted signal instead of calling the network. */
  abortOk?: boolean;
  /** What went wrong, when anything did. */
  error?: string;
}

/** Options for `runEmbeddingProviderConformance()`. */
export interface EmbeddingProviderConformanceOptions {
  /** Model to use. Defaults to the adapter's default model. */
  model?: string;
  /** Cases to run instead of the defaults. */
  fixtures?: readonly EmbeddingProviderConformanceCase[];
  /** Also checks that an already-aborted signal is honored. Defaults to true. */
  testAbort?: boolean;
  /** Runs the determinism check, which repeats one case and compares the vectors. */
  testDeterminism?: boolean;
}

/** The default embeddings conformance cases: a single input, a batch, and a query-typed input. */
export const EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES: readonly EmbeddingProviderConformanceCase[] = [
  { name: 'single-input', input: ['A short sentence about provider-neutral embeddings.'] },
  {
    name: 'batch-input',
    input: ['The first document.', 'The second document.', 'The third document.'],
  },
  { name: 'query-input-type', input: ['What does this library do?'], inputType: 'query' },
];

/**
 * Checks an embeddings adapter against the neutral contract.
 *
 * The contract an adapter has to keep is narrow but load-bearing: one vector per input, in input
 * order, of a consistent width, and an aborted signal honored before the request goes out. A store
 * built on a provider that breaks any of these degrades silently rather than failing.
 */
export async function runEmbeddingProviderConformance(
  providerName: string,
  provider: EmbeddingsProvider,
  options: EmbeddingProviderConformanceOptions = {},
): Promise<EmbeddingProviderConformanceResult[]> {
  const fixtures = options.fixtures || EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES;
  const model = options.model || provider.info.defaultModel || provider.info.capabilities.models?.[0];
  if (!model) {
    return [
      {
        providerName,
        caseName: 'model-resolution',
        ok: false,
        error: 'the adapter declares no default model and none was supplied',
      },
    ];
  }

  const results: EmbeddingProviderConformanceResult[] = [];
  let firstWidth: number | undefined;

  for (const fixture of fixtures) {
    const result: EmbeddingProviderConformanceResult = {
      providerName,
      model,
      caseName: fixture.name,
      ok: false,
    };

    try {
      const response = await provider.embed(
        {
          input: fixture.input,
          model,
          inputType: fixture.inputType,
          dimensions: fixture.dimensions,
        },
        context(`conformance-${fixture.name}`),
      );

      assert(Array.isArray(response.vectors), 'vectors must be an array');
      assert(
        response.vectors.length === fixture.input.length,
        `expected ${fixture.input.length} vectors but received ${response.vectors.length}`,
      );
      for (const vector of response.vectors) {
        assert(Array.isArray(vector) && vector.length > 0, 'every vector must be a non-empty number array');
        assert(
          vector.every((value) => typeof value === 'number' && Number.isFinite(value)),
          'every vector component must be a finite number',
        );
      }

      const width = (response.vectors[0] as number[]).length;
      assert(
        response.vectors.every((vector) => vector.length === width),
        'every vector in one call must have the same width',
      );
      if (fixture.dimensions !== undefined) {
        assert(width === fixture.dimensions, `expected ${fixture.dimensions} dimensions but received ${width}`);
      }
      if (firstWidth === undefined) firstWidth = width;
      else if (fixture.dimensions === undefined) {
        assert(width === firstWidth, `width changed between calls: ${firstWidth} then ${width}`);
      }

      if (fixture.validate) {
        assert(await fixture.validate(response), 'the fixture validator rejected the result');
      }

      result.ok = true;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    results.push(result);
  }

  if (options.testDeterminism) {
    results.push(await checkDeterminism(providerName, provider, model));
  }

  if (options.testAbort !== false) {
    results.push(await checkAbort(providerName, provider, model));
  }

  return results;
}

async function checkDeterminism(
  providerName: string,
  provider: EmbeddingsProvider,
  model: string,
): Promise<EmbeddingProviderConformanceResult> {
  const result: EmbeddingProviderConformanceResult = { providerName, model, caseName: 'determinism', ok: false };
  const request: EmbeddingProviderRequest = { input: ['A stable sentence.'], model };

  try {
    const first = await provider.embed(request, context('conformance-determinism-1'));
    const second = await provider.embed(request, context('conformance-determinism-2'));
    const a = first.vectors[0] as number[];
    const b = second.vectors[0] as number[];
    assert(a.length === b.length, 'repeated calls returned different widths');
    assert(
      a.every((value, index) => Math.abs(value - (b[index] as number)) < 1e-6),
      'repeated calls returned different vectors for the same text',
    );
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function checkAbort(
  providerName: string,
  provider: EmbeddingsProvider,
  model: string,
): Promise<EmbeddingProviderConformanceResult> {
  const result: EmbeddingProviderConformanceResult = { providerName, model, caseName: 'abort', ok: false };
  const controller = new AbortController();
  controller.abort();

  try {
    await provider.embed(
      { input: ['Aborted before dispatch.'], model },
      { ...context('conformance-abort'), signal: controller.signal },
    );
    result.abortOk = false;
    result.error = 'the adapter ignored an already-aborted signal';
  } catch {
    result.ok = true;
    result.abortOk = true;
  }

  return result;
}

function context(requestId: string): EmbeddingProviderCallContext {
  return { requestId, signal: new AbortController().signal, attempt: 1, batchIndex: 0 };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
