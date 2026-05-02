import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { withFactualDefaults } from './factual.js';

export interface ConsistencyClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export interface SelfConsistencyOptions {
  samples?: number;
  temperature?: number;
  topP?: number;
  judge?: (responses: NexusResponse[]) => Promise<NexusResponse> | NexusResponse;
}

export async function completeWithSelfConsistency(
  client: ConsistencyClient,
  request: CompletionRequest,
  options: SelfConsistencyOptions = {},
): Promise<NexusResponse> {
  const samples = Math.max(1, options.samples || 3);
  const candidates = await Promise.all(
    Array.from({ length: samples }, () => client.complete(withFactualDefaults({
      ...request,
      temperature: options.temperature ?? request.temperature ?? 0.2,
      topP: options.topP ?? request.topP ?? 0.3,
    }, {
      requireUnknownFallback: true,
      chainOfThought: 'private',
    }))),
  );

  const selected = options.judge
    ? await options.judge(candidates)
    : selectMostConsistent(candidates);

  return {
    ...selected,
    meta: {
      ...selected.meta,
      guardrailsApplied: [...selected.meta.guardrailsApplied, 'self-consistency'],
    },
  };
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
