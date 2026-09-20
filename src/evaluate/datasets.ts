import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Dataset, DatasetExample, DatasetStore, Experiment, ExperimentStore } from '../types/evaluate.js';
import type { Run, RunQuery, TraceStore } from '../types/tracing.js';

export interface CreateDatasetOptions<I, O> {
  name: string;
  examples: Array<Omit<DatasetExample<I, O>, 'id'> & { id?: string }>;
  description?: string;
  tags?: string[];
  /** Defaults to a hash of the examples, so identical content is the same version. */
  version?: string;
  now?: () => Date;
}

/**
 * Builds a dataset, versioned by its content.
 *
 * A version derived from the examples means two experiments can be compared only when they really
 * ran over the same data: change an example and the version changes with it, rather than silently
 * invalidating every earlier comparison.
 */
export function createDataset<I = unknown, O = unknown>(options: CreateDatasetOptions<I, O>): Dataset<I, O> {
  const examples = options.examples.map((example, index) => ({
    ...example,
    id: example.id ?? `ex-${index + 1}`,
  })) as Array<DatasetExample<I, O>>;

  return {
    name: options.name,
    version: options.version ?? contentVersion(examples),
    ...(options.description ? { description: options.description } : {}),
    examples,
    ...(options.tags ? { tags: options.tags } : {}),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export function contentVersion(examples: readonly DatasetExample[]): string {
  const hash = createHash('sha256');
  for (const example of examples) {
    hash.update(JSON.stringify({ id: example.id, inputs: example.inputs, expected: example.expected }));
  }
  return `v${hash.digest('hex').slice(0, 12)}`;
}

/** Examples of one split, as a dataset in its own right. */
export function splitOf<I, O>(dataset: Dataset<I, O>, split: string): Dataset<I, O> {
  const examples = dataset.examples.filter((example) => example.split === split);
  return { ...dataset, name: `${dataset.name}:${split}`, version: contentVersion(examples), examples };
}

export interface FromTracesOptions {
  name: string;
  store: TraceStore;
  query?: RunQuery;
  /** Turns a run into an example. Defaults to its inputs and outputs. */
  toExample?: (run: Run) => Omit<DatasetExample, 'id'> | undefined;
  limit?: number;
}

/**
 * Builds a dataset from recorded production runs.
 *
 * The most valuable examples are the ones that already happened: the request that failed, the answer
 * a user marked wrong. Each example keeps `sourceRunId`, so a result can always be traced back to
 * the run it came from.
 */
export async function datasetFromTraces(options: FromTracesOptions): Promise<Dataset> {
  const runs = await options.store.query({ limit: options.limit ?? 100, ...options.query });
  const examples: DatasetExample[] = [];
  for (const run of runs) {
    const example = options.toExample?.(run) ?? { inputs: run.inputs, expected: run.outputs };
    if (example) examples.push({ ...example, id: run.id, sourceRunId: run.id });
  }

  return createDataset({ name: options.name, examples, description: 'Built from recorded runs' });
}

/** Datasets in memory, keyed by name and version. */
export class MemoryDatasetStore implements DatasetStore {
  private readonly datasets = new Map<string, Dataset>();

  save(dataset: Dataset): void {
    this.datasets.set(`${dataset.name}@${dataset.version}`, dataset);
  }

  get(name: string, version?: string): Dataset | undefined {
    if (version) return this.datasets.get(`${name}@${version}`);
    const versions = [...this.datasets.values()].filter((dataset) => dataset.name === name);
    return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  list(): Array<{ name: string; versions: string[] }> {
    const byName = new Map<string, string[]>();
    for (const dataset of this.datasets.values()) {
      byName.set(dataset.name, [...(byName.get(dataset.name) ?? []), dataset.version]);
    }
    return [...byName.entries()].map(([name, versions]) => ({ name, versions }));
  }
}

/**
 * Datasets as JSON files in a directory, one file per version.
 *
 * Readable, diffable, and reviewable: a dataset belongs in version control next to the code it
 * tests, which a database row does not allow.
 */
export class FileDatasetStore implements DatasetStore {
  constructor(private readonly directory: string) {}

  async save(dataset: Dataset): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.fileOf(dataset.name, dataset.version), `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  }

  async get(name: string, version?: string): Promise<Dataset | undefined> {
    if (version) return this.read(this.fileOf(name, version));
    const versions = (await this.list()).find((entry) => entry.name === name)?.versions ?? [];
    const newest = (await Promise.all(versions.map((item) => this.read(this.fileOf(name, item)))))
      .filter((dataset): dataset is Dataset => dataset !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return newest[0];
  }

  async list(): Promise<Array<{ name: string; versions: string[] }>> {
    const { readdir } = await import('node:fs/promises');
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch {
      return [];
    }
    const byName = new Map<string, string[]>();
    for (const file of files) {
      const match = /^(.*)@(.*)\.json$/.exec(file);
      if (!match) continue;
      const [, name, version] = match as unknown as [string, string, string];
      byName.set(decodeURIComponent(name), [...(byName.get(decodeURIComponent(name)) ?? []), version]);
    }
    return [...byName.entries()].map(([name, versions]) => ({ name, versions }));
  }

  private async read(file: string): Promise<Dataset | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Dataset;
    } catch {
      return undefined;
    }
  }

  private fileOf(name: string, version: string): string {
    return path.join(this.directory, `${encodeURIComponent(name)}@${version}.json`);
  }
}

/** Experiments in memory, newest first. */
export class MemoryExperimentStore implements ExperimentStore {
  private readonly experiments: Experiment[] = [];

  save(experiment: Experiment): void {
    this.experiments.unshift(experiment);
  }

  get(id: string): Experiment | undefined {
    return this.experiments.find((experiment) => experiment.id === id);
  }

  list(filter: { name?: string; dataset?: string; limit?: number } = {}): Experiment[] {
    return this.experiments
      .filter(
        (experiment) =>
          (!filter.name || experiment.name === filter.name) &&
          (!filter.dataset || experiment.dataset.name === filter.dataset),
      )
      .slice(0, filter.limit ?? 50);
  }
}
