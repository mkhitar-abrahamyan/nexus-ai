import type {
  AssetDescriptor,
  AssetInput,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageOperation,
  ImageResult,
  MediaSafetyFinding,
} from '../types/images.js';
import type { RgbaImage } from './codec.js';
import { ImageValidationError } from './errors.js';

/**
 * Evaluation for generated media.
 *
 * A string golden file cannot tell whether an image matches its prompt, kept the parts of a photo an
 * edit was told to keep, rendered the text it was asked for, or was blocked when it should have been.
 * Generation is also stochastic, so one run proves little. This runner scores each of those,
 * repeats every case, reports distributions rather than single numbers, and routes the uncertain
 * middle to people.
 */

export interface MediaEvalExpectations {
  /** Text the image should contain, scored by the configured OCR function. */
  text?: string;
  /** Minimum OCR accuracy, 0–1. Defaults to 0.8 when `text` is set. */
  minTextAccuracy?: number;
  /** Minimum prompt alignment, 0–1, scored by the configured alignment function. */
  minAlignment?: number;
  /** For an edit: an image the result should stay perceptually close to, outside the edited area. */
  preserve?: { asset: AssetInput; minSimilarity: number };
  /** Whether this case should be blocked. Drives the false-positive and false-negative counts. */
  shouldBlock?: boolean;
  maxLatencyMs?: number;
  maxCost?: number;
}

export interface MediaEvalCase {
  id: string;
  operation: ImageOperation;
  request: ImageGenerateRequest | ImageEditRequest;
  /** Runs per case. Stochastic output needs several; defaults to the runner's `runs`. */
  runs?: number;
  expect?: MediaEvalExpectations;
  tags?: string[];
}

/** Produces one result for one run of a case — usually a thin call into `ImageManager`. */
export type MediaEvalTarget = (evalCase: MediaEvalCase, run: number) => Promise<ImageResult>;

export interface MediaEvalScorers {
  /** Returns prompt alignment from 0 to 1, typically a vision model acting as judge. */
  alignment?: (asset: AssetDescriptor, prompt: string) => Promise<number> | number;
  /** Returns the text found in an image. */
  ocr?: (asset: AssetDescriptor) => Promise<string> | string;
  /** Decodes pixels for perceptual similarity. Defaults to the bundled PNG decoder. */
  decode?: (asset: AssetInput) => Promise<RgbaImage> | RgbaImage;
}

export interface ReviewItem {
  caseId: string;
  run: number;
  reason: string;
  scores: Record<string, number>;
  asset?: AssetDescriptor;
  findings?: readonly MediaSafetyFinding[];
}

/** Where uncertain results go for a person to judge. */
export interface ReviewQueue {
  enqueue(item: ReviewItem): Promise<void> | void;
}

export class MemoryReviewQueue implements ReviewQueue {
  readonly items: ReviewItem[] = [];

  enqueue(item: ReviewItem): void {
    this.items.push(item);
  }
}

export interface MediaEvalOptions {
  scorers?: MediaEvalScorers;
  reviewQueue?: ReviewQueue;
  /**
   * Scores inside this band are neither a clear pass nor a clear fail, so they go to review instead
   * of being decided automatically. Keyed by metric: `alignment`, `textAccuracy`, `similarity`.
   */
  reviewBands?: Partial<Record<'alignment' | 'textAccuracy' | 'similarity', { min: number; max: number }>>;
  /** Default runs per case. Defaults to 1. */
  runs?: number;
}

export interface MetricStats {
  n: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  /** Normal-approximation 95% interval for the mean. Wide intervals mean more runs are needed. */
  ci95: [number, number];
}

export interface MediaEvalRunReport {
  run: number;
  passed: boolean;
  blocked: boolean;
  failures: string[];
  scores: Record<string, number>;
  error?: string;
}

export interface MediaEvalCaseReport {
  id: string;
  tags?: string[];
  runs: MediaEvalRunReport[];
  passRate: number;
  passed: boolean;
  stats: Record<string, MetricStats>;
}

export interface MediaEvalReport {
  cases: MediaEvalCaseReport[];
  passRate: number;
  metrics: Record<string, MetricStats>;
  safety: {
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
    /** Share of runs expected to pass that were blocked anyway. */
    falsePositiveRate: number;
    /** Share of runs expected to be blocked that got through. */
    falseNegativeRate: number;
  };
  operational: {
    runs: number;
    errors: number;
    errorRate: number;
    /** Runs whose result names more than one provider on its route. */
    failovers: number;
  };
  reviewQueued: number;
}

export class MediaEvalRunner {
  constructor(
    private readonly target: MediaEvalTarget,
    private readonly options: MediaEvalOptions = {},
  ) {}

  async evaluate(cases: readonly MediaEvalCase[]): Promise<MediaEvalReport> {
    if (cases.length === 0) throw new ImageValidationError('A media evaluation needs at least one case');

    const caseReports: MediaEvalCaseReport[] = [];
    const allScores: Record<string, number[]> = {};
    const safety = { truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 };
    let expectedPass = 0;
    let expectedBlock = 0;
    let errors = 0;
    let failovers = 0;
    let reviewQueued = 0;
    let totalRuns = 0;

    for (const evalCase of cases) {
      const runCount = evalCase.runs ?? this.options.runs ?? 1;
      if (!Number.isInteger(runCount) || runCount < 1) {
        throw new ImageValidationError(`Case "${evalCase.id}" must run at least once`);
      }

      const runs: MediaEvalRunReport[] = [];
      for (let run = 0; run < runCount; run += 1) {
        totalRuns += 1;
        const report = await this.runOnce(evalCase, run);
        runs.push(report.run);
        reviewQueued += report.reviewed;
        if (report.failover) failovers += 1;
        if (report.run.error && !report.run.blocked) errors += 1;

        collectScores(allScores, report.run.scores);

        if (evalCase.expect?.shouldBlock !== undefined) {
          if (evalCase.expect.shouldBlock) {
            expectedBlock += 1;
            if (report.run.blocked) safety.truePositives += 1;
            else safety.falseNegatives += 1;
          } else {
            expectedPass += 1;
            if (report.run.blocked) safety.falsePositives += 1;
            else safety.trueNegatives += 1;
          }
        }
      }

      const perMetric: Record<string, number[]> = {};
      for (const run of runs) collectScores(perMetric, run.scores);
      const passes = runs.filter((run) => run.passed).length;

      caseReports.push({
        id: evalCase.id,
        tags: evalCase.tags,
        runs,
        passRate: passes / runs.length,
        passed: passes === runs.length,
        stats: Object.fromEntries(Object.entries(perMetric).map(([metric, values]) => [metric, stats(values)])),
      });
    }

    const passedRuns = caseReports.reduce((total, item) => total + item.runs.filter((run) => run.passed).length, 0);

    return {
      cases: caseReports,
      passRate: passedRuns / totalRuns,
      metrics: Object.fromEntries(Object.entries(allScores).map(([metric, values]) => [metric, stats(values)])),
      safety: {
        ...safety,
        falsePositiveRate: expectedPass === 0 ? 0 : safety.falsePositives / expectedPass,
        falseNegativeRate: expectedBlock === 0 ? 0 : safety.falseNegatives / expectedBlock,
      },
      operational: { runs: totalRuns, errors, errorRate: errors / totalRuns, failovers },
      reviewQueued,
    };
  }

  private async runOnce(
    evalCase: MediaEvalCase,
    run: number,
  ): Promise<{ run: MediaEvalRunReport; reviewed: number; failover: boolean }> {
    const expect = evalCase.expect ?? {};
    const scores: Record<string, number> = {};
    const failures: string[] = [];
    let reviewed = 0;

    const started = Date.now();
    let result: ImageResult;
    try {
      result = await this.target(evalCase, run);
    } catch (error) {
      const blocked = isSafetyBlock(error);
      scores.latencyMs = Date.now() - started;
      const passed = blocked ? expect.shouldBlock === true : false;
      if (!passed) failures.push(blocked ? 'blocked but expected to pass' : 'run failed');
      return {
        run: {
          run,
          passed,
          blocked,
          failures,
          scores,
          error: error instanceof Error ? error.message : String(error),
        },
        reviewed,
        failover: false,
      };
    }

    const blocked = (result.safetyFindings ?? []).some((finding) => finding.action === 'block');
    if (expect.shouldBlock === true && !blocked) failures.push('expected to be blocked but was not');

    scores.latencyMs = result.meta.latencyMs ?? Date.now() - started;
    if (expect.maxLatencyMs !== undefined && scores.latencyMs > expect.maxLatencyMs) {
      failures.push(`latency ${scores.latencyMs}ms exceeded ${expect.maxLatencyMs}ms`);
    }
    if (result.meta.cost !== undefined) {
      scores.cost = result.meta.cost;
      if (expect.maxCost !== undefined && result.meta.cost > expect.maxCost) {
        failures.push(`cost ${result.meta.cost} exceeded ${expect.maxCost}`);
      }
    }

    const asset = result.assets[0];
    const enqueue = async (reason: string): Promise<void> => {
      if (!this.options.reviewQueue) return;
      await this.options.reviewQueue.enqueue({
        caseId: evalCase.id,
        run,
        reason,
        scores: { ...scores },
        asset,
        findings: result.safetyFindings,
      });
      reviewed += 1;
    };

    if (asset && expect.minAlignment !== undefined) {
      const scorer = this.requireScorer('alignment');
      scores.alignment = clamp(await scorer(asset, evalCase.request.prompt));
      if (this.inBand('alignment', scores.alignment)) await enqueue('alignment is uncertain');
      else if (scores.alignment < expect.minAlignment) {
        failures.push(`alignment ${scores.alignment.toFixed(3)} below ${expect.minAlignment}`);
      }
    }

    if (asset && expect.text !== undefined) {
      const ocr = this.requireScorer('ocr');
      scores.textAccuracy = textAccuracy(expect.text, await ocr(asset));
      const minimum = expect.minTextAccuracy ?? 0.8;
      if (this.inBand('textAccuracy', scores.textAccuracy)) await enqueue('rendered text is uncertain');
      else if (scores.textAccuracy < minimum) {
        failures.push(`text accuracy ${scores.textAccuracy.toFixed(3)} below ${minimum}`);
      }
    }

    if (asset && expect.preserve) {
      const decode = this.options.scorers?.decode ?? defaultDecode;
      scores.similarity = perceptualSimilarity(await decode(expect.preserve.asset), await decode(asset));
      if (this.inBand('similarity', scores.similarity)) await enqueue('edit preservation is uncertain');
      else if (scores.similarity < expect.preserve.minSimilarity) {
        failures.push(`similarity ${scores.similarity.toFixed(3)} below ${expect.preserve.minSimilarity}`);
      }
    }

    if ((result.safetyFindings ?? []).some((finding) => finding.action === 'review')) {
      await enqueue('a safety policy asked for review');
    }

    return {
      run: { run, passed: failures.length === 0, blocked, failures, scores },
      reviewed,
      failover: (result.meta.route?.length ?? 0) > 1,
    };
  }

  private inBand(metric: 'alignment' | 'textAccuracy' | 'similarity', value: number): boolean {
    const band = this.options.reviewBands?.[metric];
    return band !== undefined && value >= band.min && value <= band.max;
  }

  private requireScorer<K extends 'alignment' | 'ocr'>(name: K): NonNullable<MediaEvalScorers[K]> {
    const scorer = this.options.scorers?.[name];
    if (!scorer) {
      throw new ImageValidationError(
        `A case expects ${name === 'ocr' ? 'rendered text' : 'prompt alignment'}, but no "${name}" scorer is configured`,
      );
    }
    return scorer as NonNullable<MediaEvalScorers[K]>;
  }
}

/**
 * Perceptual similarity from 0 to 1, using a 64-bit difference hash.
 *
 * Robust to re-encoding, mild resizing, and compression, which is the point: an edit that kept the
 * rest of a photo should still score high after the provider re-encoded it, while a pixel diff would
 * report it as entirely changed.
 */
export function perceptualSimilarity(a: RgbaImage, b: RgbaImage): number {
  const hashA = differenceHash(a);
  const hashB = differenceHash(b);
  let distance = 0;
  for (let index = 0; index < 64; index += 1) if (hashA[index] !== hashB[index]) distance += 1;
  return 1 - distance / 64;
}

function differenceHash(image: RgbaImage): Uint8Array {
  // Box-average down to 9 × 8 greyscale, then compare horizontal neighbours.
  const columns = 9;
  const rows = 8;
  const cells = new Float64Array(columns * rows);
  const counts = new Uint32Array(columns * rows);

  for (let y = 0; y < image.height; y += 1) {
    const cellY = Math.min(rows - 1, Math.floor((y * rows) / image.height));
    for (let x = 0; x < image.width; x += 1) {
      const cellX = Math.min(columns - 1, Math.floor((x * columns) / image.width));
      const offset = (y * image.width + x) * 4;
      const luminance =
        0.299 * (image.data[offset] as number) +
        0.587 * (image.data[offset + 1] as number) +
        0.114 * (image.data[offset + 2] as number);
      cells[cellY * columns + cellX] = (cells[cellY * columns + cellX] as number) + luminance;
      counts[cellY * columns + cellX] = (counts[cellY * columns + cellX] as number) + 1;
    }
  }

  const bits = new Uint8Array(64);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns - 1; x += 1) {
      const left = (cells[y * columns + x] as number) / Math.max(1, counts[y * columns + x] as number);
      const right = (cells[y * columns + x + 1] as number) / Math.max(1, counts[y * columns + x + 1] as number);
      bits[y * 8 + x] = left > right ? 1 : 0;
    }
  }
  return bits;
}

/** OCR accuracy from 0 to 1: one minus normalised edit distance, after case and whitespace folding. */
export function textAccuracy(expected: string, actual: string): number {
  const a = normalizeText(expected);
  const b = normalizeText(actual);
  if (a.length === 0 && b.length === 0) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** Mean, spread, and a 95% interval, so a single lucky run is not mistaken for a capability. */
export function stats(values: readonly number[]): MetricStats {
  const n = values.length;
  const mean = values.reduce((total, value) => total + value, 0) / n;
  const variance = n > 1 ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const margin = n > 1 ? (1.96 * stddev) / Math.sqrt(n) : 0;
  return {
    n,
    mean,
    stddev,
    min: Math.min(...values),
    max: Math.max(...values),
    ci95: [mean - margin, mean + margin],
  };
}

function collectScores(target: Record<string, number[]>, scores: Record<string, number>): void {
  for (const [metric, value] of Object.entries(scores)) {
    const values = target[metric] ?? [];
    values.push(value);
    target[metric] = values;
  }
}

// The PNG codec loads only when a case checks preservation without its own decoder.
async function defaultDecode(asset: AssetInput): Promise<RgbaImage> {
  if (asset.location.kind !== 'bytes') {
    throw new ImageValidationError('Perceptual similarity needs byte assets; configure a decode scorer for others');
  }
  const { decodePng } = await import('./codec.js');
  return decodePng(asset.location.data);
}

function isSafetyBlock(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'ImageSafetyError' || /blocked by (input|output) safety/i.test(error.message);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
