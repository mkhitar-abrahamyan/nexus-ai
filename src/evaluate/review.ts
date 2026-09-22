import { randomBytes } from 'node:crypto';
import type { DatasetExample, EvaluationContext, EvaluationScore, Evaluator } from '../types/evaluate.js';
import type { Run, RunQuery, TraceStore } from '../types/tracing.js';

/** One item waiting for a person, with its claims and the answers it has. */
export interface ReviewItem {
  /** The item's id. */
  id: string;
  /** What is being judged, with enough context for a person to judge it. */
  subject: { inputs?: unknown; output?: unknown; runId?: string; exampleId?: string };
  /** The questions a reviewer answers. */
  rubric: ReviewQuestion[];
  /**
   * `pending` until claimed, `claimed` while someone works on it, `reviewed` once it has enough
   * answers.
   */
  status: 'pending' | 'claimed' | 'reviewed';
  /** Live claims, one per reviewer. Several at once when the item needs consensus. */
  claims: Array<{ reviewer: string; until: string }>;
  /** Answers submitted so far. */
  answers: ReviewAnswer[];
  /** ISO-8601 time the item was queued. */
  createdAt: string;
  /** Application data carried with the item. */
  metadata?: Record<string, unknown>;
}

/** One question a reviewer answers. */
export interface ReviewQuestion {
  /** Key the answer is recorded under, which becomes a score key. */
  key: string;
  /** The question, as the reviewer sees it. */
  prompt: string;
  /** What kind of answer is expected. */
  type: 'score' | 'boolean' | 'text' | 'choice';
  /** The options, for a `choice` question. */
  choices?: string[];
}

/** One reviewer's answers to an item. */
export interface ReviewAnswer {
  /** Who answered. */
  reviewer: string;
  /** The answers, as scores. */
  scores: EvaluationScore[];
  /** A note from the reviewer. */
  comment?: string;
  /** ISO-8601 time the answers were submitted. */
  submittedAt: string;
}

/** Configuration for an annotation queue. */
export interface AnnotationQueueOptions {
  /** Questions every item asks. */
  rubric: ReviewQuestion[];
  /** How long a claim lasts before the item returns to the queue. Defaults to 15 minutes. */
  leaseMs?: number;
  /** Answers needed before an item counts as reviewed. Defaults to 1. */
  consensus?: number;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/**
 * Work waiting for a person.
 *
 * Some judgements only a human can make, and the failure mode of "send it to a human" is losing
 * track of what was sent, what came back, and what is still waiting. Claims expire, so a reviewer
 * who closes the tab does not strand an item; consensus lets two reviewers see the same item when
 * one opinion is not enough.
 */
export class AnnotationQueue {
  private readonly items = new Map<string, ReviewItem>();
  private readonly now: () => Date;

  constructor(private readonly options: AnnotationQueueOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Queues something for review and returns the new item. */
  enqueue(subject: ReviewItem['subject'], metadata?: Record<string, unknown>): ReviewItem {
    const item: ReviewItem = {
      id: `review-${randomBytes(6).toString('hex')}`,
      subject,
      rubric: this.options.rubric,
      status: 'pending',
      claims: [],
      answers: [],
      createdAt: this.now().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
    this.items.set(item.id, item);
    return item;
  }

  /**
   * Claims the oldest item this reviewer can work on.
   *
   * An item needing two opinions may be claimed by two reviewers at once, but never twice by the
   * same one, and a claim that expires frees the slot again.
   */
  claim(reviewer: string): ReviewItem | undefined {
    const timestamp = this.now();
    const consensus = this.options.consensus ?? 1;

    for (const item of this.items.values()) {
      if (item.status === 'reviewed') continue;
      if (item.answers.some((answer) => answer.reviewer === reviewer)) continue;

      const live = item.claims.filter((claim) => Date.parse(claim.until) > timestamp.getTime());
      if (live.some((claim) => claim.reviewer === reviewer)) continue;
      // Slots left = opinions still needed, minus the reviewers already working on it.
      if (live.length + item.answers.length >= consensus) continue;

      const claimed: ReviewItem = {
        ...item,
        status: 'claimed',
        claims: [
          ...live,
          { reviewer, until: new Date(timestamp.getTime() + (this.options.leaseMs ?? 15 * 60 * 1000)).toISOString() },
        ],
      };
      this.items.set(item.id, claimed);
      return claimed;
    }
    return undefined;
  }

  /** Records a reviewer's answers. The item is reviewed once it has `consensus` answers. */
  submit(itemId: string, answer: Omit<ReviewAnswer, 'submittedAt'> & { submittedAt?: string }): ReviewItem {
    const item = this.items.get(itemId);
    if (!item) throw new RangeError(`No review item "${itemId}"`);

    const answers = [...item.answers, { ...answer, submittedAt: answer.submittedAt ?? this.now().toISOString() }];
    const reviewed = answers.length >= (this.options.consensus ?? 1);
    const claims = item.claims.filter((claim) => claim.reviewer !== answer.reviewer);
    const updated: ReviewItem = {
      ...item,
      answers,
      claims: reviewed ? [] : claims,
      status: reviewed ? 'reviewed' : claims.length > 0 ? 'claimed' : 'pending',
    };
    this.items.set(itemId, updated);
    return updated;
  }

  /** Items in the queue, optionally with one status. */
  list(status?: ReviewItem['status']): ReviewItem[] {
    const items = [...this.items.values()];
    return status ? items.filter((item) => item.status === status) : items;
  }

  /** Averaged scores per key across reviewers, which is what consensus is for. */
  consensusScores(itemId: string): EvaluationScore[] {
    const item = this.items.get(itemId);
    if (!item || item.answers.length === 0) return [];
    const byKey = new Map<string, number[]>();
    for (const answer of item.answers) {
      for (const score of answer.scores) byKey.set(score.key, [...(byKey.get(score.key) ?? []), score.score]);
    }
    return [...byKey.entries()].map(([key, values]) => ({
      key,
      score: values.reduce((total, value) => total + value, 0) / values.length,
      metadata: { reviewers: values.length },
    }));
  }

  /** Reviewed items as dataset examples, so human judgement becomes a regression test. */
  toExamples(): Array<Omit<DatasetExample, 'id'> & { id: string }> {
    return this.list('reviewed').map((item) => ({
      id: item.id,
      inputs: item.subject.inputs,
      expected: item.subject.output,
      metadata: {
        ...item.metadata,
        review: Object.fromEntries(this.consensusScores(item.id).map((score) => [score.key, score.score])),
      },
      ...(item.subject.runId ? { sourceRunId: item.subject.runId } : {}),
    }));
  }
}

/** Options for `evaluateOnline()`. */
export interface OnlineEvaluationOptions {
  /** Where the runs to score are. */
  store: TraceStore;
  /** Evaluators applied to each sampled run. */
  evaluators: Evaluator[];
  /** Which runs to score. Defaults to finished model runs. */
  query?: RunQuery;
  /** Share of matching runs scored, 0 to 1. Defaults to 1. */
  sampleRate?: number;
  /** Sends an uncertain result to people instead of scoring it automatically. */
  reviewQueue?: AnnotationQueue;
  /** Decides whether a run's scores are uncertain enough to send it to people. */
  reviewWhen?: (scores: EvaluationScore[], run: Run) => boolean;
  /** Writes scores back as trace feedback. Defaults to true. */
  recordFeedback?: boolean;
  /** Replaces the system clock, for feedback timestamps. */
  now?: () => Date;
}

/** What an online evaluation pass did. */
export interface OnlineEvaluationReport {
  /** Runs matching the query. */
  scanned: number;
  /** Runs scored after sampling. */
  evaluated: number;
  /** Runs sent to the review queue. */
  queuedForReview: number;
  /** Every score given. */
  scores: EvaluationScore[];
}

/**
 * Scores production runs after the fact.
 *
 * A dataset tells you whether a change works on the cases you thought of; online evaluation tells you
 * how it is doing on the ones you did not. Scores are written back as feedback on the run, so an
 * alert rule can watch them and a bad sample can become a dataset example.
 */
export async function evaluateOnline(options: OnlineEvaluationOptions): Promise<OnlineEvaluationReport> {
  const runs = await options.store.query({ kind: 'model', status: 'ok', limit: 100, ...options.query });
  const rate = options.sampleRate ?? 1;
  const now = options.now ?? (() => new Date());

  let evaluated = 0;
  let queued = 0;
  const all: EvaluationScore[] = [];

  for (const run of runs) {
    if (rate < 1 && Math.random() >= rate) continue;
    const context: EvaluationContext = {
      example: { id: run.id, inputs: run.inputs, expected: undefined },
      output: run.outputs,
      latencyMs: run.latencyMs ?? 0,
      ...(run.cost === undefined ? {} : { cost: run.cost }),
      run: 0,
    };

    const scores: EvaluationScore[] = [];
    for (const evaluator of options.evaluators) {
      const value = await evaluator(context);
      if (typeof value === 'number') scores.push({ key: 'score', score: value });
      else if (typeof value === 'boolean') scores.push({ key: 'score', score: value ? 1 : 0, passed: value });
      else scores.push(...(Array.isArray(value) ? value : [value]));
    }
    evaluated += 1;
    all.push(...scores);

    if (options.recordFeedback !== false && options.store.addFeedback) {
      for (const score of scores) {
        await options.store.addFeedback(run.id, {
          key: score.key,
          score: score.score,
          ...(score.comment ? { comment: score.comment } : {}),
          source: 'online-evaluation',
          createdAt: now().toISOString(),
        });
      }
    }

    if (options.reviewQueue && options.reviewWhen?.(scores, run)) {
      options.reviewQueue.enqueue({ inputs: run.inputs, output: run.outputs, runId: run.id }, { traceId: run.traceId });
      queued += 1;
    }
  }

  return { scanned: runs.length, evaluated, queuedForReview: queued, scores: all };
}
