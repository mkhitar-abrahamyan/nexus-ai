import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { evaluationCacheKey, fingerprintOf, MemoryEvaluationCache } from '../src/evaluate/cache.js';
import { FileEvaluationCache } from '../src/evaluate/file-cache.js';
import { compareExperiments } from '../src/evaluate/compare.js';
import { createDataset } from '../src/evaluate/datasets.js';
import { exactMatch } from '../src/evaluate/evaluators.js';
import { evaluate } from '../src/evaluate/run.js';
import { evaluatePrompt } from '../src/prompts/evaluate.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-eval-cache-'));
after(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const dataset = createDataset({
  name: 'capitals',
  examples: [
    { id: 'fr', inputs: 'France', expected: 'Paris' },
    { id: 'jp', inputs: 'Japan', expected: 'Tokyo' },
    { id: 'it', inputs: 'Italy', expected: 'Rome' },
  ],
});
const answers: Record<string, string> = { France: 'Paris', Japan: 'Tokyo', Italy: 'Milan' };

test('a cached experiment re-runs only what changed, and still scores everything', async () => {
  for (const cache of [new MemoryEvaluationCache(), new FileEvaluationCache(path.join(work, 'cache'))]) {
    const calls: string[] = [];
    const target = async (inputs: unknown) => {
      calls.push(String(inputs));
      if (inputs === 'Italy' && calls.filter((call) => call === 'Italy').length === 1) throw new Error('flaky');
      return answers[String(inputs)];
    };
    const fingerprint = await fingerprintOf({ model: 'm1', temperature: 0 });
    const first = await evaluate(target, dataset, [exactMatch()], { cache, fingerprint, concurrency: 1 });
    assert.deepEqual(calls, ['France', 'Japan', 'Italy']);
    assert.deepEqual(first.cache, { hits: 0, misses: 3 });
    assert.equal(first.errors, 1);

    const second = await evaluate(target, dataset, [exactMatch()], { cache, fingerprint, concurrency: 1 });
    assert.deepEqual(
      calls,
      ['France', 'Japan', 'Italy', 'Italy'],
      'only the failure runs again: failures are never stored',
    );
    assert.deepEqual(second.cache, { hits: 2, misses: 1 });
    assert.deepEqual(
      second.results.map((result) => [result.exampleId, result.cached ?? false, result.scores[0]?.score]),
      [
        ['fr', true, 1],
        ['jp', true, 1],
        ['it', false, 0],
      ],
      'cached outputs are scored again',
    );
    assert.equal(second.results[0]?.latencyMs, first.results[0]?.latencyMs, 'a cached run keeps the latency it had');

    const changed = await evaluate(target, dataset, [exactMatch()], {
      cache,
      fingerprint: await fingerprintOf({ model: 'm2', temperature: 0 }),
      concurrency: 1,
    });
    assert.deepEqual(changed.cache, { hits: 0, misses: 3 }, 'a new fingerprint reuses nothing');
    assert.equal(compareExperiments(second, changed).datasetMismatch, undefined);
  }
});

test('the cache key and fingerprint are stable, and a cache needs a fingerprint', async () => {
  assert.equal(await fingerprintOf({ a: 1, b: [2] }), await fingerprintOf({ b: [2], a: 1 }));
  assert.match(await fingerprintOf('x'), /^f[0-9a-f]{16}$/);
  const example = { id: 'a', inputs: { q: 1 }, expected: 'x' };
  assert.equal(
    await evaluationCacheKey('f1', example, 0),
    await evaluationCacheKey('f1', { ...example, expected: 'changed' }, 0),
    'the expected output is not part of the key',
  );
  assert.notEqual(await evaluationCacheKey('f1', example, 0), await evaluationCacheKey('f1', example, 1));
  await assert.rejects(
    evaluate(() => 'x', dataset, [], { cache: new MemoryEvaluationCache() }),
    /needs a fingerprint/,
  );

  const small = new MemoryEvaluationCache({ maxEntries: 2 });
  small.set('a', { output: { v: 1 }, latencyMs: 1, cachedAt: 'now' });
  small.set('b', { output: 2, latencyMs: 1, cachedAt: 'now' });
  (small.get('a')?.output as { v: number }).v = 99;
  small.set('c', { output: 3, latencyMs: 1, cachedAt: 'now' });
  assert.equal(small.size(), 2);
  assert.equal(small.get('b'), undefined, 'the least recently used goes first');
  assert.deepEqual(small.get('a')?.output, { v: 1 }, 'a caller cannot change what is stored');
  await assert.rejects(
    new FileEvaluationCache(work).set('../escape', { output: 1, latencyMs: 0, cachedAt: '' }),
    /hex/,
  );
});

test('evaluatePrompt fingerprints the prompt version, so a changed prompt runs again', async () => {
  let calls = 0;
  const client = {
    complete: async () => {
      calls++;
      return { content: 'Paris', role: 'assistant' as const, finishReason: 'stop' as const } as never;
    },
  };
  const cache = new MemoryEvaluationCache();
  const prompt = { name: 'capital', messages: [{ role: 'user' as const, content: 'Capital of {{input}}?' }] };
  await evaluatePrompt(prompt, dataset, [exactMatch()], { client, cache });
  await evaluatePrompt(prompt, dataset, [exactMatch()], { client, cache });
  assert.equal(calls, 3, 'the second run of the same version is answered from the cache');
  await evaluatePrompt(
    { ...prompt, messages: [{ role: 'user', content: 'What is the capital of {{input}}?' }] },
    dataset,
    [],
    {
      client,
      cache,
    },
  );
  assert.equal(calls, 6, 'a new version runs again');
});
