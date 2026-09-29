import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createDataset, MemoryExperimentStore } from '../src/evaluate/datasets.js';
import { contains } from '../src/evaluate/evaluators.js';
import { createHashEmbeddings } from '../src/hallucination/retrieval.js';
import {
  clusterRuns,
  detectRegressions,
  errorSignature,
  FileProposalStore,
  findIssues,
  MemoryProposalStore,
  modelFixProposer,
  ProposalInbox,
  proposeFix,
  trajectoryOf,
} from '../src/insights/index.js';
import { evaluatePrompt } from '../src/prompts/evaluate.js';
import { experimentGate } from '../src/prompts/gates.js';
import { PromptRegistry } from '../src/prompts/registry.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { Run, RunTree } from '../src/types/tracing.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-insights-'));
after(() => rmSync(work, { recursive: true, force: true }));

let sequence = 0;
function run(fields: Partial<Run> & { startedAt: string }): Run {
  const id = fields.id ?? `run-${++sequence}`;
  return { id, traceId: fields.traceId ?? id, name: 'support-agent', kind: 'agent', status: 'ok', ...fields };
}

test('error signatures take out what varies, so one failure reads the same every time', () => {
  assert.equal(
    errorSignature('Order 12345 not found for "ana@example.com" at https://api.test/orders/12345'),
    'Order <n> not found for <value> at <url>',
  );
  assert.equal(
    errorSignature('Timeout after 30.5s for request 9f1c2b3a-1111-2222-3333-444455556666'),
    'Timeout after <n>s for request <id>',
  );
  assert.equal(errorSignature('hash deadbeefcafe0123 failed'), 'hash <hex> failed');
});

test('runs cluster by error, by the path they took, and by meaning', async () => {
  const at = '2026-09-29T10:00:00.000Z';
  const failing = [
    run({ startedAt: at, status: 'error', error: { name: 'TypeError', message: "Cannot read 'total' of undefined" } }),
    run({ startedAt: at, status: 'error', error: { name: 'TypeError', message: "Cannot read 'items' of undefined" } }),
    run({ startedAt: at, status: 'error', error: { name: 'RateLimitError', message: 'Retry after 12 seconds' } }),
  ];
  const byError = await clusterRuns(failing);
  assert.deepEqual(
    byError.map((cluster) => [cluster.count, cluster.signature]),
    [
      [2, 'support-agent: TypeError: Cannot read <value> of undefined'],
      [1, 'support-agent: RateLimitError: Retry after <n> seconds'],
    ],
  );
  assert.equal((await clusterRuns(failing)).at(0)?.id, byError[0]?.id, 'cluster ids are stable');
  assert.equal((await clusterRuns(failing, { minSize: 2 })).length, 1);

  const tree = (id: string, steps: string[]): RunTree => ({
    ...run({ id, startedAt: at }),
    children: steps.map((name, index) => ({
      ...run({
        id: `${id}-${index}`,
        traceId: id,
        parentId: id,
        name,
        kind: 'tool',
        startedAt: `2026-09-29T10:00:0${index}.000Z`,
      }),
      children: [],
    })),
  });
  assert.deepEqual(trajectoryOf(tree('t', ['search', 'answer'])), ['tool:search', 'tool:answer']);
  const byPath = await clusterRuns(
    [tree('a', ['search', 'answer']), tree('b', ['search', 'answer']), tree('c', ['answer'])],
    {
      by: 'trajectory',
    },
  );
  assert.deepEqual(
    byPath.map((cluster) => [cluster.count, cluster.signature]),
    [
      [2, 'support-agent: tool:search > tool:answer'],
      [1, 'support-agent: tool:answer'],
    ],
  );

  const embed = (texts: string[]) => createHashEmbeddings(texts, 256);
  const byMeaning = await clusterRuns(
    [
      run({ startedAt: at, outputs: 'the refund was declined by the bank' }),
      run({ startedAt: at, outputs: 'the refund was declined by the bank today' }),
      run({ startedAt: at, outputs: 'shipping is delayed' }),
    ],
    { by: 'meaning', embed, threshold: 0.8 },
  );
  assert.deepEqual(
    byMeaning.map((cluster) => cluster.count),
    [2, 1],
  );
  await assert.rejects(clusterRuns(failing, { by: 'meaning' }), /needs an embed function/);
});

test('findIssues reports failing and slow clusters in a window, most common first', async () => {
  const store = new MemoryTraceStore();
  const now = new Date('2026-09-29T12:00:00.000Z');
  for (let index = 0; index < 6; index++) {
    store.save(
      run({
        startedAt: '2026-09-29T11:00:00.000Z',
        status: 'error',
        error: { name: 'Error', message: `Order ${index} has no total` },
      }),
    );
  }
  store.save(
    run({ startedAt: '2026-09-29T11:00:00.000Z', status: 'error', error: { name: 'Error', message: 'once' } }),
  );
  for (let index = 0; index < 3; index++) store.save(run({ startedAt: '2026-09-29T11:30:00.000Z', latencyMs: 9000 }));
  for (let index = 0; index < 10; index++) store.save(run({ startedAt: '2026-09-29T11:30:00.000Z', latencyMs: 200 }));
  store.save(
    run({
      startedAt: '2026-09-27T11:00:00.000Z',
      status: 'error',
      error: { name: 'Error', message: 'Order 1 has no total' },
    }),
  );
  store.save(
    run({
      id: 'child',
      traceId: 'run-1',
      parentId: 'run-1',
      startedAt: '2026-09-29T11:00:00.000Z',
      status: 'error',
      error: { name: 'Error', message: 'x' },
    }),
  );

  const issues = await findIssues({ store, slowMs: 5000, now: () => now });
  assert.deepEqual(
    issues.map((issue) => [issue.kind, issue.cluster.count]),
    [
      ['failing', 6],
      ['slow', 3],
    ],
    'a single failure is not an issue, old runs are outside the window, and child runs are not counted',
  );
  assert.equal(issues[0]?.summary, '6 failing runs of support-agent: Error: Order <n> has no total');
  assert.ok(Math.abs((issues[0]?.rate ?? 0) - 6 / 20) < 1e-9);
  assert.deepEqual(await findIssues({ store, since: '2030-01-01T00:00:00.000Z' }), []);
});

test('detectRegressions flags a real rise in errors, latency, cost, and a fall in feedback', async () => {
  const store = new MemoryTraceStore();
  for (let index = 0; index < 40; index++) {
    store.save(
      run({
        startedAt: '2026-09-20T10:00:00.000Z',
        status: index < 2 ? 'error' : 'ok',
        latencyMs: 200 + index,
        cost: 0.001,
        feedback: [{ key: 'helpful', score: 0.9, createdAt: '2026-09-20T10:00:00.000Z' }] as never,
      }),
    );
    store.save(
      run({
        startedAt: '2026-09-28T10:00:00.000Z',
        status: index < 12 ? 'error' : 'ok',
        latencyMs: 400 + index,
        cost: 0.002,
        feedback: [{ key: 'helpful', score: 0.5, createdAt: '2026-09-28T10:00:00.000Z' }] as never,
      }),
    );
    store.save(run({ name: 'quiet', startedAt: '2026-09-28T10:00:00.000Z', status: index < 1 ? 'error' : 'ok' }));
  }
  const regressions = await detectRegressions({
    store,
    baseline: { since: '2026-09-19T00:00:00.000Z', until: '2026-09-21T00:00:00.000Z' },
    current: { since: '2026-09-27T00:00:00.000Z' },
    feedback: ['helpful'],
  });
  assert.deepEqual(
    regressions.map((regression) => `${regression.group} ${regression.metric}`),
    ['support-agent error-rate', 'support-agent latency-p95', 'support-agent cost', 'support-agent feedback:helpful'],
    'a group without a baseline is not judged',
  );
  assert.match(regressions[0]?.summary ?? '', /error rate rose from 5\.0% to 30\.0%/);
  const strict = await detectRegressions({
    store,
    baseline: { since: '2026-09-19T00:00:00.000Z', until: '2026-09-21T00:00:00.000Z' },
    current: { since: '2026-09-27T00:00:00.000Z' },
    metrics: ['latency'],
    latencyIncrease: 2,
    minRuns: 50,
  });
  assert.deepEqual(strict, [], 'too few runs, or a rise inside the margin, is not a regression');
});

test('a proposed fix is evaluated before anyone sees it, and a person promotes it through the gates', async () => {
  const experiments = new MemoryExperimentStore();
  const registry = new PromptRegistry({
    gates: { production: [experimentGate({ store: experiments, noRegression: true })] },
  });
  const current = await registry.commit(
    { name: 'answer', messages: [{ role: 'user', content: 'Answer: {{input}}' }] },
    { label: 'production' },
  );
  const dataset = createDataset({
    name: 'orders',
    examples: [1, 2, 3, 4, 5, 6, 7, 8].map((number) => ({
      id: `o${number}`,
      inputs: `order ${number}`,
      expected: 'order',
    })),
  });
  // The model answers with the order number only when the prompt asks it to.
  const client = {
    complete: async (request: CompletionRequest) => {
      const text = String(request.messages[0]?.content);
      return { content: text.includes('cite the order') ? `About your ${text.split(': ')[1]}` : 'Done.' } as never;
    },
  };
  const evaluate = (version: { name: string; version: string }) =>
    evaluatePrompt(version as never, dataset, [contains(['order'])], { client, store: experiments });
  const store = new MemoryProposalStore();
  const issue = (
    await findIssues({
      store: (() => {
        const traces = new MemoryTraceStore();
        for (let index = 0; index < 3; index++) {
          traces.save(
            run({
              startedAt: '2026-09-29T11:00:00.000Z',
              status: 'error',
              error: { name: 'Error', message: 'answer lacks the order' },
            }),
          );
        }
        return traces;
      })(),
      now: () => new Date('2026-09-29T12:00:00.000Z'),
    })
  )[0];
  assert.ok(issue);

  const opened: Array<{ title: string; branch: string; files: Record<string, string> }> = [];
  const proposal = await proposeFix({
    issue,
    subject: { kind: 'prompt', registry, name: 'answer', label: 'production' },
    propose: ({ current: version }) => ({
      definition: { name: 'answer', messages: [{ role: 'user', content: 'Answer and cite the order: {{input}}' }] },
      rationale: `Asked ${(version as { version: string }).version} to cite the order`,
    }),
    evaluate,
    store,
    pullRequest: {
      client: {
        createPullRequest: async (request) => {
          opened.push(request);
          return { url: 'https://forge.test/pr/1' };
        },
      },
    },
  });
  assert.ok(proposal);
  assert.equal(proposal.verdict, 'improved');
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.baseline.version, current.version);
  assert.equal(proposal.pullRequest?.url, 'https://forge.test/pr/1');
  assert.deepEqual(Object.keys(opened[0]?.files ?? {}), ['prompts/answer.json']);
  assert.match(opened[0]?.branch ?? '', /^nexus\/fix-/);
  assert.equal(
    (await registry.get('answer', 'production')).version,
    current.version,
    'nothing is promoted without a person',
  );

  const inbox = new ProposalInbox({ store, prompts: registry });
  assert.deepEqual(
    (await inbox.list()).map((item) => item.id),
    [proposal.id],
  );
  const promoted = await inbox.promote(proposal.id, { by: 'lead' });
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.decidedBy, 'lead');
  assert.equal(
    (await registry.get('answer', 'production')).version,
    proposal.candidate.version,
    'the gate passed on the stored experiment',
  );
  await assert.rejects(inbox.promote(proposal.id, { by: 'lead' }), /is promoted, not pending/);

  const noBetter = await proposeFix({
    issue,
    subject: { kind: 'prompt', registry, name: 'answer', label: 'production' },
    propose: () => ({
      definition: { name: 'answer', messages: [{ role: 'user', content: 'Please cite the order: {{input}}' }] },
    }),
    evaluate,
    store,
  });
  assert.equal(noBetter?.status, 'discarded', 'a fix that does not improve never reaches the inbox');
  assert.deepEqual(await inbox.list(), []);
  assert.equal(
    await proposeFix({
      issue,
      subject: { kind: 'prompt', registry, name: 'answer', label: 'production' },
      propose: () => undefined,
      evaluate,
    }),
    undefined,
  );
  await assert.rejects(
    proposeFix({
      issue,
      subject: { kind: 'prompt', registry, name: 'answer', label: 'production' },
      propose: () => ({ definition: { name: 'other', messages: [] } }),
      evaluate,
    }),
    /named "other"/,
  );
});

test('the model proposer reads a JSON reply, and proposals persist as files', async () => {
  const registry = new PromptRegistry();
  const current = await registry.commit({ name: 'answer', messages: [{ role: 'user', content: 'Answer: {{input}}' }] });
  const replies = [
    'Here: {"messages": [{"role": "user", "content": "Answer, citing the order: {{input}}"}], "rationale": "cite it"}',
    'no json',
  ];
  const proposer = modelFixProposer({ complete: async () => ({ content: replies.shift() ?? '' }) }, { model: 'fixer' });
  const issue = {
    id: 'failing-x',
    kind: 'failing',
    rate: 1,
    summary: 'answers lack the order',
    cluster: { runs: [] },
  } as never;
  const candidate = await proposer({ issue, kind: 'prompt', current, examples: [] });
  assert.ok(candidate);
  assert.equal(
    (candidate.definition as { messages: Array<{ content: string }> }).messages[0]?.content,
    'Answer, citing the order: {{input}}',
  );
  assert.equal(candidate?.rationale, 'cite it');
  assert.equal(await proposer({ issue, kind: 'prompt', current, examples: [] }), undefined);

  const files = new FileProposalStore(path.join(work, 'proposals'));
  const proposal = {
    id: 'fix-1',
    issueId: 'failing-x',
    issue: 'x',
    kind: 'prompt' as const,
    name: 'answer',
    label: 'production',
    baseline: { version: 'p1', experiment: 'e1' },
    candidate: { version: 'p2', experiment: 'e2' },
    verdict: 'improved' as const,
    metrics: [],
    status: 'pending' as const,
    createdAt: '2026-09-29T00:00:00.000Z',
  };
  await files.save(proposal);
  assert.deepEqual(await files.get('fix-1'), proposal);
  assert.equal((await files.list({ status: 'pending' })).length, 1);
  assert.deepEqual(await new FileProposalStore(path.join(work, 'none')).list(), []);
  assert.equal(await files.get('../x'), undefined, 'an unsafe id reads nothing');
  await assert.rejects(files.save({ ...proposal, id: '../x' }), /letters, digits/);
});
