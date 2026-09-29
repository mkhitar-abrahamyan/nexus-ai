import { randomUUID } from 'node:crypto';
import type { ContextBundle, ContextBundleDefinition, ContextHub } from '../context-hub/hub.js';
import type { CompareOptions, MetricComparison } from '../evaluate/compare.js';
import type { PromptRegistry } from '../prompts/registry.js';
import type { Experiment } from '../types/evaluate.js';
import type { CompletionRequest } from '../types/messages.js';
import type { PromptDefinition, PromptVersion } from '../types/prompts.js';
import type { Run } from '../types/tracing.js';
import type { Issue } from './clusters.js';

/** What a fix changes: a prompt in a registry, or a context bundle in a hub, served by a label. */
export type FixSubject =
  | { kind: 'prompt'; registry: PromptRegistry; name: string; label: string }
  | { kind: 'context'; hub: ContextHub; name: string; label: string };

/** What a fix proposer is given: the issue, the version the label serves, and some runs that show it. */
export interface FixRequest {
  /** The issue to fix. */
  issue: Issue;
  /** Whether a prompt or a bundle is changed, and which. */
  kind: 'prompt' | 'context';
  /** The version the label serves now. */
  current: PromptVersion | ContextBundle;
  /** Up to five of the issue's runs. */
  examples: Run[];
}

/** A proposed new definition, and why it should fix the issue. */
export interface FixCandidate {
  /** The new prompt or bundle definition, under the same name. */
  definition: PromptDefinition | ContextBundleDefinition;
  /** Why it should help, shown to the person who decides. */
  rationale?: string;
}

/** Proposes a fix, or `undefined` when it has none: `modelFixProposer()`, or your own code. */
export type FixProposer = (request: FixRequest) => Promise<FixCandidate | undefined> | FixCandidate | undefined;

/** Opens a pull request. Inject a client for your forge — GitHub, GitLab, or another — so none is a dependency. */
export interface PullRequestClient {
  /** Opens a pull request that writes `files` on a new `branch`, and returns its address. */
  createPullRequest(request: {
    title: string;
    body: string;
    branch: string;
    base?: string;
    files: Record<string, string>;
  }): Promise<{ url: string }>;
}

/** A proposed fix: the candidate, how it scored against the current version, and what a person decided. */
export interface FixProposal {
  /** The proposal's id. */
  id: string;
  /** The issue it answers. */
  issueId: string;
  /** The issue's summary, as it read when the fix was proposed. */
  issue: string;
  /** Whether a prompt or a bundle is changed. */
  kind: 'prompt' | 'context';
  /** The prompt or bundle. */
  name: string;
  /** The label the fix would be promoted to. */
  label: string;
  /** The version the label served, and the experiment that scored it. */
  baseline: { version: string; experiment: string };
  /** The proposed version, committed without a label, and the experiment that scored it. */
  candidate: { version: string; experiment: string };
  /** Why the proposer thinks it helps. */
  rationale?: string;
  /** `improved` when a metric got better and none got worse, beyond noise. */
  verdict: 'improved' | 'unchanged' | 'regressed';
  /** Every metric both experiments scored, with its verdict. */
  metrics: MetricComparison[];
  /** `pending` waits for a person; `discarded` did not improve; `promoted` and `rejected` were decided. */
  status: 'pending' | 'promoted' | 'rejected' | 'discarded';
  /** ISO-8601 time it was proposed. */
  createdAt: string;
  /** ISO-8601 time it was decided. */
  decidedAt?: string;
  /** Who decided. */
  decidedBy?: string;
  /** Why, as the person who decided wrote it. */
  note?: string;
  /** The pull request opened for it, when one was. */
  pullRequest?: { url: string };
}

/** Where proposals are kept. */
export interface ProposalStore {
  /** Stores a proposal, replacing one with the same id. */
  save(proposal: FixProposal): Promise<void> | void;
  /** Reads a proposal. */
  get(id: string): Promise<FixProposal | undefined> | FixProposal | undefined;
  /** Proposals, newest first, optionally with one status. */
  list(filter?: { status?: FixProposal['status']; limit?: number }): Promise<FixProposal[]> | FixProposal[];
}

/** Proposals in process memory. */
export class MemoryProposalStore implements ProposalStore {
  private readonly proposals = new Map<string, FixProposal>();

  /** Stores a copy of a proposal. */
  save(proposal: FixProposal): void {
    this.proposals.set(proposal.id, structuredClone(proposal));
  }

  /** A copy of a proposal. */
  get(id: string): FixProposal | undefined {
    const found = this.proposals.get(id);
    return found ? structuredClone(found) : undefined;
  }

  /** Proposals, newest first. */
  list(filter: { status?: FixProposal['status']; limit?: number } = {}): FixProposal[] {
    return [...this.proposals.values()]
      .filter((proposal) => !filter.status || proposal.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100)
      .map((proposal) => structuredClone(proposal));
  }
}

/** Proposals as one JSON file each in a directory, so a shared studio keeps them across restarts. */
export class FileProposalStore implements ProposalStore {
  constructor(private readonly directory: string) {}

  /** Writes a proposal through a temporary file and a rename. */
  async save(proposal: FixProposal): Promise<void> {
    const { mkdir, rename, writeFile } = await import('node:fs/promises');
    await mkdir(this.directory, { recursive: true });
    const file = await this.fileOf(proposal.id);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  }

  /** Reads a proposal. */
  async get(id: string): Promise<FixProposal | undefined> {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(await this.fileOf(id), 'utf8')) as FixProposal;
    } catch {
      return undefined;
    }
  }

  /** Proposals, newest first. */
  async list(filter: { status?: FixProposal['status']; limit?: number } = {}): Promise<FixProposal[]> {
    const { readdir } = await import('node:fs/promises');
    let files: string[];
    try {
      files = (await readdir(this.directory)).filter((file) => file.endsWith('.json'));
    } catch {
      return [];
    }
    const proposals = await Promise.all(files.map((file) => this.get(file.slice(0, -5))));
    return proposals
      .filter((proposal): proposal is FixProposal => Boolean(proposal))
      .filter((proposal) => !filter.status || proposal.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100);
  }

  private async fileOf(id: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new RangeError('A proposal id holds only letters, digits, - and _');
    const path = await import('node:path');
    return path.join(this.directory, `${id}.json`);
  }
}

/** Options for `proposeFix()`. */
export interface ProposeFixOptions {
  /** The issue to fix. */
  issue: Issue;
  /** The prompt or bundle to change, and the label that serves it. */
  subject: FixSubject;
  /** Proposes the new definition. */
  propose: FixProposer;
  /**
   * Scores a version over your dataset: `evaluatePrompt()` or `evaluateContext()` with your client
   * and evaluators. Store the experiments, so the promotion's experiment gate finds the candidate's.
   */
  evaluate: (version: PromptVersion | ContextBundle) => Promise<Experiment>;
  /** Passed to `compareExperiments()`. */
  compare?: CompareOptions;
  /** Where the proposal is kept, for the studio's inbox. */
  store?: ProposalStore;
  /** Opens a pull request for an improving fix, with the files `files` writes — by default the candidate as JSON. */
  pullRequest?: {
    client: PullRequestClient;
    base?: string;
    files?: (proposal: FixProposal, candidate: PromptVersion | ContextBundle) => Record<string, string>;
  };
  /** Recorded as the candidate's author. Defaults to `insights`. */
  by?: string;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/**
 * Proposes a fix for an issue and measures it before anyone is asked: the proposer writes a new
 * definition, it is committed without a label, the current version and the candidate are both scored
 * over your dataset, and the comparison decides. An improvement is kept as a `pending` proposal for a
 * person to promote — through the label's gates, as any promotion — and anything else is `discarded`,
 * with the evidence. Resolves `undefined` when the proposer had nothing, or proposed what is served.
 */
export async function proposeFix(options: ProposeFixOptions): Promise<FixProposal | undefined> {
  const { subject } = options;
  const current =
    subject.kind === 'prompt'
      ? await subject.registry.get(subject.name, subject.label)
      : await subject.hub.get(subject.name, subject.label);
  const candidate = await options.propose({
    issue: options.issue,
    kind: subject.kind,
    current,
    examples: options.issue.cluster.runs.slice(0, 5),
  });
  if (!candidate) return undefined;
  if (candidate.definition.name !== subject.name) {
    throw new RangeError(`A fix for "${subject.name}" proposed a definition named "${candidate.definition.name}"`);
  }
  const commit = { message: `Proposed fix for ${options.issue.id}`, author: options.by ?? 'insights' };
  const committed =
    subject.kind === 'prompt'
      ? await subject.registry.commit(candidate.definition as PromptDefinition, commit)
      : await subject.hub.commit(candidate.definition as ContextBundleDefinition, commit);
  if (committed.version === current.version) return undefined;

  const baseline = await options.evaluate(current);
  const scored = await options.evaluate(committed);
  const { compareExperiments, formatComparison } = await import('../evaluate/compare.js');
  const comparison = compareExperiments(baseline, scored, options.compare);
  const verdict = comparison.regressed
    ? 'regressed'
    : comparison.metrics.some((metric) => metric.verdict === 'better')
      ? 'improved'
      : 'unchanged';
  const proposal: FixProposal = {
    id: `fix-${randomUUID()}`,
    issueId: options.issue.id,
    issue: options.issue.summary,
    kind: subject.kind,
    name: subject.name,
    label: subject.label,
    baseline: { version: current.version, experiment: baseline.id },
    candidate: { version: committed.version, experiment: scored.id },
    ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
    verdict,
    metrics: comparison.metrics,
    status: verdict === 'improved' ? 'pending' : 'discarded',
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  if (verdict === 'improved' && options.pullRequest) {
    const directory = subject.kind === 'prompt' ? 'prompts' : 'contexts';
    const files = options.pullRequest.files?.(proposal, committed) ?? {
      [`${directory}/${subject.name}.json`]: `${JSON.stringify(committed, null, 2)}\n`,
    };
    proposal.pullRequest = await options.pullRequest.client.createPullRequest({
      title: `Fix ${subject.name}: ${options.issue.summary}`.slice(0, 200),
      body: [
        `Proposed for issue \`${options.issue.id}\`: ${options.issue.summary}`,
        candidate.rationale ? `\n${candidate.rationale}` : '',
        `\n\`${current.version}\` → \`${committed.version}\`\n`,
        '```',
        formatComparison(comparison),
        '```',
      ].join('\n'),
      branch: `nexus/${proposal.id}`,
      ...(options.pullRequest.base ? { base: options.pullRequest.base } : {}),
      files,
    });
  }
  await options.store?.save(proposal);
  return proposal;
}

/** Options for a `ProposalInbox`. */
export interface ProposalInboxOptions {
  /** Where proposals are kept. */
  store: ProposalStore;
  /** The prompt registry prompt fixes are promoted in. */
  prompts?: PromptRegistry;
  /** The context hub bundle fixes are promoted in. */
  contexts?: ContextHub;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/**
 * The proposals waiting for a person, and the two decisions they can make. Promoting goes through the
 * label's gates like any promotion; the studio's inbox is this, behind roles.
 */
export class ProposalInbox {
  constructor(private readonly options: ProposalInboxOptions) {}

  /** Proposals, newest first, optionally with one status. Defaults to `pending`. */
  async list(status: FixProposal['status'] | 'all' = 'pending'): Promise<FixProposal[]> {
    return [...(await this.options.store.list(status === 'all' ? {} : { status }))];
  }

  /** One proposal. */
  async get(id: string): Promise<FixProposal | undefined> {
    return this.options.store.get(id);
  }

  /** Promotes a pending proposal's candidate to its label, through the label's gates, and records who did. */
  async promote(id: string, options: { by: string; note?: string }): Promise<FixProposal> {
    const proposal = await this.pending(id);
    const promotion = {
      to: proposal.label,
      version: proposal.candidate.version,
      by: options.by,
      note: options.note ?? `proposal ${proposal.id}`,
    };
    if (proposal.kind === 'prompt') {
      if (!this.options.prompts)
        throw new RangeError('Promoting a prompt fix needs the inbox to have a prompt registry');
      await this.options.prompts.promote(proposal.name, promotion);
    } else {
      if (!this.options.contexts) throw new RangeError('Promoting a context fix needs the inbox to have a context hub');
      await this.options.contexts.promote(proposal.name, promotion);
    }
    return this.decide(proposal, 'promoted', options);
  }

  /** Rejects a pending proposal. The candidate version stays committed, unlabelled. */
  async reject(id: string, options: { by: string; note?: string }): Promise<FixProposal> {
    return this.decide(await this.pending(id), 'rejected', options);
  }

  private async pending(id: string): Promise<FixProposal> {
    const proposal = await this.options.store.get(id);
    if (!proposal) throw new RangeError(`There is no proposal "${id}"`);
    if (proposal.status !== 'pending') throw new RangeError(`Proposal "${id}" is ${proposal.status}, not pending`);
    return proposal;
  }

  private async decide(
    proposal: FixProposal,
    status: 'promoted' | 'rejected',
    options: { by: string; note?: string },
  ): Promise<FixProposal> {
    const decided: FixProposal = {
      ...proposal,
      status,
      decidedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      decidedBy: options.by,
      ...(options.note ? { note: options.note } : {}),
    };
    await this.options.store.save(decided);
    return decided;
  }
}

/** A client that runs one completion — a `NexusAI` instance, or anything with the same `complete()`. */
export interface FixModelClient {
  /** Runs one completion and returns its text. */
  complete(request: CompletionRequest): Promise<{ content: string }>;
}

/** Options for `modelFixProposer()`. */
export interface ModelFixProposerOptions {
  /** The model that writes fixes. */
  model: string;
  /** Characters of each example run's inputs and error shown to the model. Defaults to 800. */
  maxExampleCharacters?: number;
}

/**
 * A fix proposer over a chat model: it is shown the issue, the current prompt's messages or the
 * bundle's instructions, and example runs, and asked for replacements as JSON. A reply it cannot read
 * proposes nothing. Every proposal is still evaluated before anyone sees it.
 */
export function modelFixProposer(client: FixModelClient, options: ModelFixProposerOptions): FixProposer {
  const limit = options.maxExampleCharacters ?? 800;
  return async (request) => {
    const examples = request.examples
      .map(
        (run, index) =>
          `Example ${index + 1}\ninputs: ${JSON.stringify(run.inputs ?? null).slice(0, limit)}\n${
            run.error
              ? `error: ${run.error.name}: ${run.error.message.slice(0, limit)}`
              : `outputs: ${JSON.stringify(run.outputs ?? null).slice(0, limit)}`
          }`,
      )
      .join('\n\n');
    const isPrompt = request.kind === 'prompt';
    const current = isPrompt
      ? JSON.stringify((request.current as PromptVersion).messages, null, 2)
      : JSON.stringify((request.current as ContextBundle).instructions ?? {}, null, 2);
    const response = await client.complete({
      model: options.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: isPrompt
            ? 'You fix prompts. Reply with only JSON: {"messages": [...the full replacement messages, same shape...], "rationale": "one or two sentences"}. Keep every {{variable}}.'
            : 'You fix agent instructions. Reply with only JSON: {"instructions": {...the full replacement, name to text...}, "rationale": "one or two sentences"}.',
        },
        {
          role: 'user',
          content: `Issue: ${request.issue.summary}\n\nCurrent ${isPrompt ? 'messages' : 'instructions'}:\n${current}\n\n${examples}`,
        },
      ],
    });
    let parsed: { messages?: unknown; instructions?: unknown; rationale?: unknown };
    try {
      const text = response.content;
      parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {
      return undefined;
    }
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : undefined;
    if (isPrompt) {
      if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return undefined;
      const {
        version: _v,
        variables: _vars,
        createdAt: _c,
        parent: _p,
        message: _m,
        author: _a,
        ...definition
      } = request.current as PromptVersion;
      return {
        definition: { ...definition, messages: parsed.messages as PromptDefinition['messages'] },
        ...(rationale ? { rationale } : {}),
      };
    }
    if (!parsed.instructions || typeof parsed.instructions !== 'object' || Array.isArray(parsed.instructions))
      return undefined;
    const {
      version: _v,
      createdAt: _c,
      parent: _p,
      message: _m,
      author: _a,
      ...definition
    } = request.current as ContextBundle;
    return {
      definition: { ...definition, instructions: parsed.instructions as Record<string, string> },
      ...(rationale ? { rationale } : {}),
    };
  };
}
