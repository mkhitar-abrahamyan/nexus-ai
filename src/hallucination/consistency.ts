import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { withFactualDefaults } from './factual.js';

export interface ConsistencyClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export interface SelfConsistencyOptions {
  samples?: number;
  maxConcurrency?: number;
  temperature?: number;
  topP?: number;
  judge?: (responses: NexusResponse[]) => Promise<NexusResponse> | NexusResponse;
}

interface SampleFailure {
  index: number;
  error: unknown;
}

export async function completeWithSelfConsistency(
  client: ConsistencyClient,
  request: CompletionRequest,
  options: SelfConsistencyOptions = {},
): Promise<NexusResponse> {
  const requestedSamples = options.samples ?? 3;
  const samples = Math.max(1, Number.isFinite(requestedSamples) ? Math.floor(requestedSamples) : 3);
  const requestedConcurrency = options.maxConcurrency ?? 2;
  const maxConcurrency = Math.min(
    samples,
    Math.max(1, Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 2),
  );
  const sampleRequests = Array.from({ length: samples }, () => withFactualDefaults({
      ...request,
      temperature: options.temperature ?? request.temperature ?? 0.2,
      topP: options.topP ?? request.topP ?? 0.3,
    }, {
      requireUnknownFallback: true,
      chainOfThought: 'private',
    }));
  const { candidates, failures } = await completeSamples(client, sampleRequests, maxConcurrency);

  if (candidates.length === 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Self-consistency failed: all ${samples} samples failed`,
    );
  }

  const selected = options.judge
    ? await options.judge(candidates)
    : selectMostConsistent(candidates);

  const guardrailsApplied = [...selected.meta.guardrailsApplied, 'self-consistency'];
  if (failures.length > 0) {
    guardrailsApplied.push(`self-consistency-recovered-${failures.length}`);
  }

  return {
    ...selected,
    meta: {
      ...selected.meta,
      guardrailsApplied,
    },
  };
}

async function completeSamples(
  client: ConsistencyClient,
  requests: CompletionRequest[],
  maxConcurrency: number,
): Promise<{ candidates: NexusResponse[]; failures: SampleFailure[] }> {
  const candidateSlots: Array<NexusResponse | undefined> = new Array(requests.length);
  const failures: SampleFailure[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < requests.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        candidateSlots[index] = await client.complete(requests[index]);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  }

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  const candidates = candidateSlots.filter((candidate): candidate is NexusResponse => Boolean(candidate));
  return { candidates, failures };
}

export function selectMostConsistent(responses: NexusResponse[]): NexusResponse {
  if (responses.length === 0) {
    throw new Error('selectMostConsistent requires at least one response');
  }
  if (responses.length === 1) return responses[0];

  let best = responses[0];
  let bestScore = -1;

  for (const response of responses) {
    const score = responses
      .filter((candidate) => candidate !== response)
      .reduce((sum, candidate) => sum + textSimilarity(response.content, candidate.content), 0);

    if (score > bestScore) {
      best = response;
      bestScore = score;
    }
  }

  return best;
}

export function textSimilarity(a: string, b: string): number {
  const aTerms = new Set(terms(a));
  const bTerms = new Set(terms(b));
  if (aTerms.size === 0 && bTerms.size === 0) return 1;
  if (aTerms.size === 0 || bTerms.size === 0) return 0;

  let intersection = 0;
  aTerms.forEach((term) => {
    if (bTerms.has(term)) intersection += 1;
  });

  return intersection / (aTerms.size + bTerms.size - intersection);
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_'-]{3,}/g) || [];
}
