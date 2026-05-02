import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { withFactualDefaults } from './factual.js';

export interface VerificationClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export interface VerificationFact {
  text: string;
  supported: boolean;
  score: number;
}

export interface VerificationReport {
  ok: boolean;
  facts: VerificationFact[];
  unsupported: VerificationFact[];
  supportRatio: number;
}

export interface NliVerifier {
  verify(claim: string, context: string): Promise<{ entailed: boolean; score: number }>;
}

export interface VerificationOptions {
  context: string[];
  minSupportRatio?: number;
  nli?: NliVerifier;
  unknownAnswer?: string;
  repair?: boolean;
}

export async function completeVerified(
  client: VerificationClient,
  request: CompletionRequest,
  options: VerificationOptions,
): Promise<NexusResponse> {
  const initial = await client.complete(withFactualDefaults(request, {
    requireUnknownFallback: true,
    unknownAnswer: options.unknownAnswer || "I don't know.",
    chainOfThought: 'private',
  }));
  const report = await verifyAgainstContext(initial.content, options);

  if (report.ok || options.repair === false) {
    return attachVerification(initial, report);
  }

  const repaired = await client.complete(withFactualDefaults({
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'assistant',
        content: initial.content,
      },
      {
        role: 'user',
        content: [
          'Revise the answer so every factual claim is supported by the context.',
          `If unsupported, answer exactly: "${options.unknownAnswer || "I don't know."}"`,
          'Unsupported claims:',
          ...report.unsupported.map((fact) => `- ${fact.text}`),
          'Context:',
          ...options.context.map((item, index) => `[context-${index + 1}] ${item}`),
        ].join('\n'),
      },
    ],
  }, {
    requireUnknownFallback: true,
    unknownAnswer: options.unknownAnswer || "I don't know.",
    chainOfThought: 'private',
  }));

  return attachVerification(repaired, await verifyAgainstContext(repaired.content, options));
}

export async function verifyAgainstContext(
  answer: string,
  options: VerificationOptions,
): Promise<VerificationReport> {
  const context = options.context.join('\n');
  const facts = extractFacts(answer);

  if (facts.length === 0) {
    return { ok: true, facts: [], unsupported: [], supportRatio: 1 };
  }

  const checked = await Promise.all(facts.map(async (fact) => {
    const result = options.nli
      ? await options.nli.verify(fact, context)
      : lexicalEntailment(fact, context);
    return {
      text: fact,
      supported: result.entailed,
      score: result.score,
    };
  }));

  const supported = checked.filter((fact) => fact.supported).length;
  const supportRatio = supported / checked.length;
  const minSupportRatio = options.minSupportRatio ?? 0.85;
  const unsupported = checked.filter((fact) => !fact.supported);

  return {
    ok: supportRatio >= minSupportRatio && unsupported.length === 0,
    facts: checked,
    unsupported,
    supportRatio,
  };
}

export function extractFacts(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !/^(i don't know|unknown|not enough information)/i.test(part));
}

export function lexicalEntailment(claim: string, context: string): { entailed: boolean; score: number } {
  const claimTerms = importantTerms(claim);
  if (claimTerms.length === 0) return { entailed: true, score: 1 };

  const contextTerms = new Set(importantTerms(context));
  const matches = claimTerms.filter((term) => contextTerms.has(term)).length;
  const score = matches / claimTerms.length;

  return {
    entailed: score >= 0.72 || context.toLowerCase().includes(claim.toLowerCase()),
    score,
  };
}

function importantTerms(text: string): string[] {
  const stop = new Set([
    'about', 'after', 'also', 'because', 'before', 'being', 'could', 'from',
    'have', 'into', 'only', 'over', 'than', 'that', 'their', 'there', 'these',
    'this', 'those', 'through', 'under', 'using', 'were', 'when', 'where',
    'which', 'while', 'with', 'would', 'your',
  ]);

  return (text.toLowerCase().match(/[a-z0-9_'-]{3,}/g) || [])
    .filter((term) => !stop.has(term));
}

function attachVerification(response: NexusResponse, report: VerificationReport): NexusResponse {
  return {
    ...response,
    meta: {
      ...response.meta,
      guardrailsApplied: [...response.meta.guardrailsApplied, 'chain-of-verification'],
      verification: {
        ok: report.ok,
        supportRatio: report.supportRatio,
        factsChecked: report.facts.length,
        unsupportedFacts: report.unsupported.map((fact) => fact.text),
      },
    },
    content: response.content,
  };
}
