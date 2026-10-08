import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  bindTools,
  ContextDefinitionError,
  ContextHub,
  ContextNotFoundError,
  ContextPromotionError,
  contextExperimentGate,
  contextInstructions,
  contextVersion,
  evaluateContext,
  formatContextDiff,
  servedByContextGate,
} from '../src/context-hub/index.js';
import { MemoryEvaluationCache } from '../src/evaluate/cache.js';
import { createDataset, MemoryExperimentStore } from '../src/evaluate/datasets.js';
import { contains } from '../src/evaluate/evaluators.js';
import { FilePromptStore } from '../src/prompts/file.js';
import { PromptRegistry } from '../src/prompts/registry.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-context-hub-'));
after(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

async function setup() {
  const prompts = new PromptRegistry();
  const answer = await prompts.commit({
    name: 'support-answer',
    messages: [{ role: 'user', content: 'Answer {{question}}' }],
  });
  const experiments = new MemoryExperimentStore();
  const hub = new ContextHub({
    prompts,
    gates: {
      production: [
        servedByContextGate('staging'),
        contextExperimentGate({ store: experiments, thresholds: { contains: 1 } }),
      ],
    },
  });
  const base = {
    name: 'support-agent',
    description: 'Answers billing questions',
    prompts: { answer: { name: 'support-answer', version: answer.version } },
    instructions: { policy: 'Never promise a refund.', tone: 'Be brief.' },
    tools: [{ name: 'lookup_order', description: 'Finds an order', parameters: { type: 'object' } }],
    skills: { refunds: { description: 'Refund questions', instructions: 'Check the order first.' } },
    config: { model: 'gpt-5.4-mini' },
  };
  return { prompts, hub, experiments, base, answer };
}

test('a bundle commits by content, labels, and renders its pinned prompt', async () => {
  const { hub, base, answer } = await setup();
  const first = await hub.commit(base, { message: 'first', author: 'ana', label: 'staging' });
  assert.match(first.version, /^c[0-9a-f]{12}$/);
  assert.equal(first.version, await contextVersion(base));
  const again = await hub.commit({ ...base, metadata: { owner: 'billing' } });
  assert.equal(again.version, first.version, 'unchanged content, even with new metadata, is the same version');
  assert.equal((await hub.history('support-agent')).filter((entry) => entry.action === 'commit').length, 1);

  const second = await hub.commit({ ...base, instructions: { ...base.instructions, tone: 'Be brief and kind.' } });
  assert.equal(second.parent, first.version);
  assert.equal((await hub.get('support-agent')).version, second.version, 'latest is the newest');
  assert.equal((await hub.get('support-agent', 'staging')).version, first.version);
  assert.deepEqual(await hub.names(), ['support-agent']);
  assert.deepEqual((await hub.resolve('support-agent', 'staging')).reference, {
    name: 'support-agent',
    version: first.version,
    label: 'staging',
  });

  const request = await hub.renderPrompt(first, 'answer', { question: 'Where is my refund?' });
  assert.equal(request.messages[0]?.content, 'Answer Where is my refund?');
  assert.deepEqual(request.metadata.prompt, { name: 'support-answer', version: answer.version });
  assert.deepEqual(request.metadata.context, { name: 'support-agent', version: first.version });

  await assert.rejects(hub.get('support-agent', 'missing'), ContextNotFoundError);
  await assert.rejects(
    hub.commit({ ...base, prompts: { answer: { name: 'support-answer', version: 'p000000000000' } } }),
    /does not have/,
  );
  await assert.rejects(hub.commit({ ...base, tools: [base.tools[0], base.tools[0]] as never }), /twice/);
  await assert.rejects(hub.commit({ name: '' }), ContextDefinitionError);
});

test('promotion runs the gates, including an experiment over the exact version, and rollback undoes it', async () => {
  const { hub, base, experiments } = await setup();
  const good = await hub.commit(base, { label: 'staging' });
  const dataset = createDataset({ name: 'refunds', examples: [{ id: 'a', inputs: 'refund?', expected: 'order' }] });
  const answer = (bundle: { instructions?: Record<string, string> }) =>
    bundle.instructions?.policy?.includes('refund') ? 'Check the order first.' : 'Sure!';

  await assert.rejects(hub.promote('support-agent', { from: 'staging', to: 'production' }), (error: unknown) => {
    assert.ok(error instanceof ContextPromotionError);
    assert.match(error.message, /no experiment/);
    return true;
  });
  const cache = new MemoryEvaluationCache();
  let runs = 0;
  const target = (bundle: typeof good) => {
    runs++;
    return answer(bundle);
  };
  const experiment = await evaluateContext(good, dataset, [contains(['order'])], target, { store: experiments, cache });
  assert.deepEqual(experiment.metadata?.context, { name: 'support-agent', version: good.version });
  await evaluateContext(good, dataset, [contains(['order'])], target, { store: experiments, cache });
  assert.equal(runs, 1, 'an unchanged bundle is answered from the evaluation cache');

  const promoted = await hub.promote('support-agent', { from: 'staging', to: 'production', by: 'lead' });
  assert.equal(promoted.label.version, good.version);
  assert.ok(promoted.results.every((result) => result.ok));

  const worse = await hub.commit({ ...base, instructions: { tone: 'Be brief.' } }, { label: 'staging' });
  await evaluateContext(worse, dataset, [contains(['order'])], target, { store: experiments });
  await assert.rejects(hub.promote('support-agent', { from: 'staging', to: 'production' }), /contains is 0\.000/);
  const forced = await hub.promote('support-agent', {
    version: worse.version,
    to: 'production',
    force: true,
    by: 'lead',
  });
  assert.equal(forced.label.version, worse.version);
  assert.match((await hub.history('support-agent', { label: 'production' }))[0]?.note ?? '', /forced past experiment/);

  const back = await hub.rollback('support-agent', 'production', { by: 'lead' });
  assert.equal(back.version, good.version);
  assert.equal((await hub.get('support-agent', 'production')).version, good.version);
  assert.equal(await hub.unlabel('support-agent', 'staging'), true);
  assert.deepEqual(
    (await hub.labels('support-agent')).map((label) => label.label),
    ['production'],
  );
});

test('a diff shows each changed entry, with line diffs for text', async () => {
  const { hub, base } = await setup();
  const before = await hub.commit(base);
  const after = await hub.commit({
    ...base,
    instructions: { policy: 'Never promise a refund.\nEscalate chargebacks.' },
    tools: [...base.tools, { name: 'escalate' }],
    config: { model: 'gpt-5.4' },
  });
  const diff = await hub.diff('support-agent', before.version, after.version);
  assert.deepEqual(
    diff.changes.map((change) => `${change.change} ${change.section}.${change.key}`),
    ['changed instructions.policy', 'removed instructions.tone', 'added tools.escalate', 'changed config.model'],
  );
  assert.deepEqual(
    diff.changes[0]?.lines?.filter((line) => line.op !== '='),
    [{ op: '+', text: 'Escalate chargebacks.' }],
  );
  const text = formatContextDiff(diff);
  assert.match(text, /\+ Escalate chargebacks\./);
  assert.match(text, /changed config\.model/);
  assert.equal((await hub.diff('support-agent', before.version, before.version)).changes.length, 0);
});

test('an export carries its prompts into another project, stored as files, and a tampered one is refused', async () => {
  const { hub, base } = await setup();
  const bundle = await hub.commit(base);
  const exported = await hub.export('support-agent');
  assert.equal(exported.prompts.length, 1);

  const directory = path.join(work, 'contexts');
  const elsewhere = new ContextHub({ store: new FilePromptStore(directory), prompts: new PromptRegistry() });
  const imported = await elsewhere.import(JSON.parse(JSON.stringify(exported)), { label: 'staging', by: 'ops' });
  assert.equal(imported.version, bundle.version, 'the same content is the same version in any project');
  assert.equal((await elsewhere.get('support-agent', 'staging')).version, bundle.version);
  assert.ok(
    readdirSync(path.join(directory, 'support-agent', 'versions')).includes(`${bundle.version}.json`),
    'one reviewable file per version',
  );
  assert.equal(
    (await new ContextHub({ store: new FilePromptStore(directory) }).get('support-agent')).version,
    bundle.version,
  );

  const tampered = structuredClone(exported);
  tampered.bundle.instructions = { policy: 'Promise refunds.' };
  await assert.rejects(new ContextHub({ prompts: new PromptRegistry() }).import(tampered), /content has changed/);
  const badPrompt = structuredClone(exported);
  (badPrompt.prompts[0] as { messages: Array<{ content: string }> }).messages[0].content = 'Edited';
  await assert.rejects(new ContextHub({ prompts: new PromptRegistry() }).import(badPrompt), /was exported as/);
  await assert.rejects(new ContextHub().import(exported), /give the hub a prompt registry/);
  await assert.rejects(new ContextHub().import({ format: 'other' } as never), /Not a nexus-context-bundle/);
});

test('instructions join in order, and tools bind to implementations the bundle names', async () => {
  const { hub, base } = await setup();
  const bundle = await hub.commit(base);
  assert.equal(contextInstructions(bundle), 'Never promise a refund.\n\nBe brief.');
  assert.equal(contextInstructions(bundle, { include: ['tone', 'missing'] }), 'Be brief.');
  const tools = bindTools(bundle, { lookup_order: (args) => `order ${args.id}`, delete_everything: () => 'no' });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['lookup_order'],
    'an implementation the bundle does not offer is never exposed',
  );
  assert.equal(await tools[0]?.execute?.({ id: 7 }), 'order 7');
  assert.throws(() => bindTools(bundle, {}), /no implementation/);
  assert.deepEqual(bindTools(bundle, {}, { strict: false }), []);
});
