/**
 * Registry data on its own: a file the application supplies, checked, layered over the bundled data,
 * and compared with the providers' own model lists. Nothing is fetched but those lists.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { refreshReport, runModelsCommand } from '../src/cli/models.js';
import { NexusAI } from '../src/core/nexus.js';
import { diagnose } from '../src/doctor/index.js';
import { EmbeddingManager } from '../src/embeddings/manager.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import {
  bundledRegistryData,
  checkRegistryData,
  diffRegistryData,
  parseRegistryData,
  REGISTRY_DATA_FORMAT,
  RegistryDataError,
  registryDataAgeDays,
  withRegistryData,
} from '../src/models/data.js';
import { checkRegistryFreshness } from '../src/models/registry.js';
import { BaseProvider } from '../src/providers/base.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream } from '../src/types/response.js';

const directory = mkdtempSync(path.join(tmpdir(), 'nexus-registry-data-'));
after(() => rmSync(directory, { recursive: true, force: true }));

class FixedUsageProvider extends BaseProvider {
  readonly info = { name: 'fixed', isLocal: false };
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    return {
      content: 'ok',
      role: 'assistant',
      finishReason: 'stop',
      meta: {
        requestId: 'r',
        providerUsed: 'openai',
        modelUsed: request.model,
        latencyMs: 1,
        tokensInput: 1_000,
        tokensOutput: 1_000,
        tokensSaved: 0,
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }
  stream(): NexusStream {
    throw new Error('not used');
  }
}

test('the bundled data is valid registry data, and survives being a file', () => {
  const data = bundledRegistryData();
  assert.equal(data.format, REGISTRY_DATA_FORMAT);
  assert.deepEqual(checkRegistryData(data), []);
  const read = parseRegistryData(JSON.stringify(data));
  assert.ok(Object.keys(read.models).length > 50);
  assert.ok(read.embeddingModels?.['gemini-embedding-2']);
  assert.deepEqual(diffRegistryData(data, read), { added: [], removed: [], changed: [], aliases: [] });
});

test('every problem in a file is reported, each with where it is', () => {
  const data = bundledRegistryData();
  const broken = structuredClone(data) as unknown as Record<string, Record<string, Record<string, unknown>>>;
  (broken.models['gpt-5.4-mini'] as Record<string, unknown>).costPer1kInput = -1;
  (broken.models['gpt-5.4-mini'] as Record<string, unknown>).inputModalities = ['text', 'smell'];
  delete (broken.models['gpt-5.4-mini'] as Record<string, unknown>).maxContextTokens;
  (broken.aliases as unknown as Record<string, string>).fast = 'no-such-model';
  const embedding = broken.embeddingModels['gemini-embedding-2'] as Record<string, unknown>;
  embedding.dimensions = 0;
  embedding.costPerAudioSecond = -1;
  embedding.costPerVideoFrame = 'cheap';
  embedding.maxVideoSeconds = 0;
  embedding.maxAudioSeconds = Number.POSITIVE_INFINITY;
  embedding.videoFrames = { perSecond: 1, max: 2.5 };
  const problems = checkRegistryData(broken);
  assert.deepEqual(problems.sort(), [
    'aliases.fast: names no model in the file or the bundled data',
    'embeddingModels.gemini-embedding-2.costPerAudioSecond: a price of zero or more',
    'embeddingModels.gemini-embedding-2.costPerVideoFrame: a price of zero or more',
    'embeddingModels.gemini-embedding-2.dimensions: a positive integer',
    'embeddingModels.gemini-embedding-2.maxAudioSeconds: a number above zero',
    'embeddingModels.gemini-embedding-2.maxVideoSeconds: a number above zero',
    'embeddingModels.gemini-embedding-2.videoFrames: { perSecond } above zero, with a max a positive integer',
    'models.gpt-5.4-mini.costPer1kInput: a price of zero or more',
    'models.gpt-5.4-mini.inputModalities: a list of text, image, audio, video, pdf',
    'models.gpt-5.4-mini.maxContextTokens: a positive integer',
  ]);
  assert.throws(
    () => parseRegistryData(broken),
    (error: unknown) => error instanceof RegistryDataError && error.problems.length === 10,
  );
  for (const frames of [
    { perSecond: 0 },
    { perSecond: Number.POSITIVE_INFINITY },
    'one a second',
    null,
    { perSecond: 2, max: 0 },
  ]) {
    const sampled = structuredClone(data) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    (sampled.embeddingModels['gemini-embedding-2'] as Record<string, unknown>).videoFrames = frames;
    assert.deepEqual(
      checkRegistryData(sampled),
      ['embeddingModels.gemini-embedding-2.videoFrames: { perSecond } above zero, with a max a positive integer'],
      JSON.stringify(frames),
    );
  }
  const unbounded = structuredClone(data) as unknown as Record<string, Record<string, Record<string, unknown>>>;
  (unbounded.embeddingModels['gemini-embedding-2'] as Record<string, unknown>).videoFrames = { perSecond: 0.5 };
  assert.deepEqual(checkRegistryData(unbounded), [], 'a rate with no most');
  assert.match(checkRegistryData('{ not json')[0] ?? '', /not JSON/);
  assert.deepEqual(checkRegistryData({ ...data, format: 'other/2' }), ['format: expected "nexus-registry/1"']);
});

test('proof: a price changed in a supplied file reaches the cost of the next call', async () => {
  const bundled = new NexusAI({ providers: {}, routing: { mode: 'direct' }, security: 'off' });
  bundled.registerProvider('openai', new FixedUsageProvider());
  const before = await bundled.complete({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] });

  // The application's file says the price went up tenfold, before any runtime release says so.
  const file = path.join(directory, 'registry.json');
  const data = bundledRegistryData();
  const entry = data.models['gpt-5.4-mini'];
  assert.ok(entry);
  entry.costPer1kInput *= 10;
  entry.costPer1kOutput *= 10;
  writeFileSync(file, JSON.stringify(data));

  const supplied = new NexusAI(
    withRegistryData(
      { providers: {}, routing: { mode: 'direct' }, security: 'off' },
      parseRegistryData(readFileSync(file, 'utf8')),
    ),
  );
  supplied.registerProvider('openai', new FixedUsageProvider());
  const after = await supplied.complete({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(before.meta.cost && after.meta.cost);
  assert.ok(Math.abs(after.meta.cost.amount - before.meta.cost.amount * 10) < 1e-9, 'ten times the cost');

  // Embedding prices travel the same way.
  const embedding = data.embeddingModels?.['text-embedding-3-small'];
  assert.ok(embedding);
  embedding.costPer1kInput = 1;
  const config = withRegistryData({ providers: {} }, data);
  const embeddings = new EmbeddingManager({
    ...config.embeddings,
    providers: { openai: new MockEmbeddingProvider({ name: 'openai', defaultModel: 'text-embedding-3-small' }) },
    defaultProvider: 'openai',
  });
  const priced = await embeddings.embed({ input: 'one two three four', model: 'text-embedding-3-small' });
  assert.ok(Math.abs(priced.meta.cost.amount - 0.004) < 1e-9, 'four tokens at the supplied $1 per 1,000');
});

test("an application's own entries win over the file's, which win over the bundled ones", () => {
  const data = bundledRegistryData();
  const mini = data.models['gpt-5.4-mini'];
  assert.ok(mini);
  data.models['gpt-5.4-mini'] = { ...mini, costPer1kInput: 2 };
  data.aliases = { ...data.aliases, house: 'gpt-5.4-mini' };
  const config = withRegistryData(
    {
      providers: {},
      models: { registry: { 'gpt-5.4-mini': { ...mini, costPer1kInput: 3 } }, aliases: { house: 'gpt-5.4' } },
    },
    data,
  );
  assert.equal(config.models?.registry?.['gpt-5.4-mini']?.costPer1kInput, 3);
  assert.equal(config.models?.aliases?.house, 'gpt-5.4');
  assert.equal(config.models?.verifiedAt, data.verifiedAt);
});

test('freshness is measured from the supplied data, in the registry check and the doctor', async () => {
  const now = new Date('2027-09-01T00:00:00Z');
  const stale = checkRegistryFreshness({ now });
  assert.equal(stale.stale, true, 'the bundled data is a year old by then');
  const fresh = checkRegistryFreshness({ now, config: { models: { verifiedAt: '2027-08-20' } } });
  assert.equal(fresh.verifiedAt, '2027-08-20');
  assert.equal(fresh.ageDays, 12);
  assert.equal(registryDataAgeDays({ verifiedAt: '2027-08-20' }, now), 12);

  const report = await diagnose({ now: () => now, models: { verifiedAt: '2027-08-20' }, env: {} });
  const registry = report.checks.find((check) => check.id === 'registry');
  assert.equal(registry?.status, 'ok');
  const old = await diagnose({ now: () => now, env: {} });
  assert.match(old.checks.find((check) => check.id === 'registry')?.hint ?? '', /withRegistryData/);
});

test('the diff names what a file adds, removes, and reprices', () => {
  const before = bundledRegistryData();
  const after = structuredClone(before);
  const mini = after.models['gpt-5.4-mini'];
  assert.ok(mini);
  after.models['gpt-5.4-mini'] = { ...mini, costPer1kInput: 9 };
  after.models['house-model'] = { ...mini, provider: 'openai' };
  delete after.models['gpt-5.4'];
  after.embeddingAliases = { ...after.embeddingAliases, 'embed-house': 'gemini-embedding-2' };
  const diff = diffRegistryData(before, after);
  assert.deepEqual(diff.added, ['house-model']);
  assert.deepEqual(diff.removed, ['gpt-5.4']);
  assert.deepEqual(diff.changed, [
    { model: 'gpt-5.4-mini', changes: [{ field: 'costPer1kInput', from: mini.costPer1kInput, to: 9 }] },
  ]);
  assert.deepEqual(diff.aliases, [{ alias: 'embedding:embed-house', to: 'gemini-embedding-2' }]);
});

test('nexus models export, check, and refresh', async () => {
  const out = path.join(directory, 'exported.json');
  const print = console.log;
  const printError = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await runModelsCommand('export', { positionals: [], flags: { out } });
    assert.deepEqual(checkRegistryData(readFileSync(out, 'utf8')), []);

    await runModelsCommand('check', { positionals: [out], flags: {} });
    assert.ok(lines.some((line) => line.includes('0 added, 0 removed, 0 changed')));
    assert.equal(process.exitCode ?? 0, 0);

    const invalid = path.join(directory, 'invalid.json');
    writeFileSync(
      invalid,
      JSON.stringify({ format: REGISTRY_DATA_FORMAT, version: '', verifiedAt: 'soon', models: {} }),
    );
    await runModelsCommand('check', { positionals: [invalid], flags: {} });
    assert.equal(process.exitCode, 1, 'an invalid file fails the command');
    process.exitCode = 0;
    assert.ok(lines.some((line) => line.includes('verifiedAt: an ISO date')));

    const requested: string[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
      requested.push(`${new URL(url).host} ${JSON.stringify(init.headers)}`);
      if (url.startsWith('https://api.openai.com/v1/models')) {
        return Response.json({ data: [{ id: 'gpt-5.4-mini' }, { id: 'gpt-7-preview' }] });
      }
      if (url.startsWith('https://api.anthropic.com/v1/models')) {
        const second = url.includes('after_id=');
        return Response.json({
          data: second ? [{ id: 'claude-next' }] : [{ id: 'claude-sonnet-5-5' }],
          has_more: !second,
          last_id: 'claude-sonnet-5-5',
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;
    lines.length = 0;
    await runModelsCommand(
      'refresh',
      { positionals: [], flags: { providers: 'openai,anthropic,google', json: true } },
      { fetch, env: { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' } },
    );
    assert.equal(requested.length, 3, 'only the providers with keys were asked, Anthropic across two pages');
    assert.ok(requested.every((request) => /api\.(openai|anthropic)\.com/.test(request)));
  } finally {
    console.log = print;
    console.error = printError;
  }

  const report = refreshReport(bundledRegistryData(), { openai: ['gpt-5.4-mini', 'gpt-7-preview'] });
  assert.deepEqual(report[0]?.missing, ['gpt-7-preview']);
  assert.ok(report[0]?.unlisted.includes('text-embedding-3-small'), 'embedding models are compared too');
  assert.ok(!report[0]?.unlisted.includes('gpt-5.4-mini'));
});
