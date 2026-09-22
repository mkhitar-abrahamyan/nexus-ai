import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Dataset, DatasetExample, DatasetStore, Experiment, ExperimentStore } from '../types/evaluate.js';
import type { Run, RunQuery, TraceStore } from '../types/tracing.js';
import { contentVersion } from './version.js';

export { contentVersion };

/** Options for `createDataset()`. */
export interface CreateDatasetOptions<I, O> {
  /** The dataset's name. */
  name: string;
  /** The examples. Those without an id are numbered `ex-1`, `ex-2`, and so on. */
  examples: Array<Omit<DatasetExample<I, O>, 'id'> & { id?: string }>;
  /** What the dataset is for. */
  description?: string;
  /** Labels for filtering. */
  tags?: string[];
  /** Defaults to a hash of the examples, so identical content is the same version. */
  version?: string;
  /** Replaces the system clock, for `createdAt`. */
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

/** Examples of one split, as a dataset in its own right. */
export function splitOf<I, O>(dataset: Dataset<I, O>, split: string): Dataset<I, O> {
  const examples = dataset.examples.filter((example) => example.split === split);
  return { ...dataset, name: `${dataset.name}:${split}`, version: contentVersion(examples), examples };
}

/** Options for `datasetFromTraces()`. */
export interface FromTracesOptions {
  /** The dataset's name. */
  name: string;
  /** Where the runs are. */
  store: TraceStore;
  /** Which runs to use. */
  query?: RunQuery;
  /** Turns a run into an example. Defaults to its inputs and outputs. */
  toExample?: (run: Run) => Omit<DatasetExample, 'id'> | undefined;
  /** Most runs read. Defaults to 100. */
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

  /** Saves a dataset version. */
  save(dataset: Dataset): void {
    this.datasets.set(`${dataset.name}@${dataset.version}`, dataset);
  }

  /** Returns a version, or the newest when none is given. */
  get(name: string, version?: string): Dataset | undefined {
    if (version) return this.datasets.get(`${name}@${version}`);
    const versions = [...this.datasets.values()].filter((dataset) => dataset.name === name);
    return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** Every dataset name with its versions. */
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

  /** Writes a dataset version to its file. */
  async save(dataset: Dataset): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.fileOf(dataset.name, dataset.version), `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  }

  /** Returns a version, or the newest when none is given. */
  async get(name: string, version?: string): Promise<Dataset | undefined> {
    if (version) return this.read(this.fileOf(name, version));
    const versions = (await this.list()).find((entry) => entry.name === name)?.versions ?? [];
    const newest = (await Promise.all(versions.map((item) => this.read(this.fileOf(name, item)))))
      .filter((dataset): dataset is Dataset => dataset !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return newest[0];
  }

  /** Every dataset name with its versions, from the file names. */
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

/**
 * Experiments as JSON files in a directory, one file per experiment.
 *
 * What a CI job wants: the baseline is a file the pipeline can cache or commit, and the candidate is
 * a file the next step can compare against it.
 */
export class FileExperimentStore implements ExperimentStore {
  constructor(private readonly directory: string) {}

  /** Writes an experiment to its file. */
  async save(experiment: Experiment): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.fileOf(experiment.id), `${JSON.stringify(experiment, null, 2)}\n`, 'utf8');
  }

  /** Reads an experiment by id. */
  async get(id: string): Promise<Experiment | undefined> {
    return readExperiment(this.fileOf(id));
  }

  /** Experiments, newest first, filtered by name or dataset. Defaults to 50. */
  async list(filter: { name?: string; dataset?: string; limit?: number } = {}): Promise<Experiment[]> {
    const { readdir } = await import('node:fs/promises');
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch {
      return [];
    }
    const experiments = await Promise.all(
      files.filter((file) => file.endsWith('.json')).map((file) => readExperiment(path.join(this.directory, file))),
    );
    return experiments
      .filter((experiment): experiment is Experiment => experiment !== undefined)
      .filter(
        (experiment) =>
          (!filter.name || experiment.name === filter.name) &&
          (!filter.dataset || experiment.dataset.name === filter.dataset),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, filter.limit ?? 50);
  }

  private fileOf(id: string): string {
    return path.join(this.directory, `${encodeURIComponent(id)}.json`);
  }
}

/** Reads an experiment file, or `undefined` when it is missing or is not an experiment. */
export async function readExperiment(file: string): Promise<Experiment | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Experiment;
    return parsed && Array.isArray(parsed.results) && parsed.dataset ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Experiments in memory, newest first. */
export class MemoryExperimentStore implements ExperimentStore {
  private readonly experiments: Experiment[] = [];

  /** Saves an experiment. */
  save(experiment: Experiment): void {
    this.experiments.unshift(experiment);
  }

  /** Reads an experiment by id. */
  get(id: string): Experiment | undefined {
    return this.experiments.find((experiment) => experiment.id === id);
  }

  /** Experiments, newest first, filtered by name or dataset. Defaults to 50. */
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
