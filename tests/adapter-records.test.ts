/**
 * Compatibility records: what an adapter's `verify()` proved, sealed, listed on one page, and
 * checked again against a release before it ships.
 *
 * A community adapter lives in a directory of its own, a vector store that marks a deleted id as gone
 * and never clears the mark, importing nothing but the adapter kit. Its record, made when 2.14 was
 * current, passed contract v1. `nexus adapters recheck` verifies it again against this release, whose
 * contract v2 adds a check the store does not meet, and turns its record red, naming the check; the
 * fixed version passes, and the page says which records are stale.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ADAPTER_CONTRACTS,
  type CompatibilityRecord,
  CompatibilityRecordError,
  compareRecords,
  compatibilityPage,
  compatibilityRecord,
  defineStoreAdapter,
  defineVectorStoreAdapter,
  readCompatibilityRecord,
  recordDigest,
  recordStatus,
} from '../src/adapter-kit/index.js';
import { MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { MemoryStore } from '../src/store/memory.js';
import { NEXUS_VERSION } from '../src/version.js';
import { adapterSource, nexus } from './community-adapter.js';

const embed = async (texts: string[]) =>
  texts.map((text) => {
    const vector = new Array(256).fill(0);
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let hash = 0x811c9dc5;
      for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
      vector[hash % 256] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  });

const memory = defineVectorStoreAdapter({
  name: '@acme/memory-vectors',
  version: '1.2.0',
  nexus: '^2.4.0',
  capabilities: { filters: 'exact' },
  create: () => new MemoryVectorStore(embed),
  budgets: { search: 500 },
});

/** A record, as it would have been made when an older release was current. */
function madeAgainst(record: CompatibilityRecord, nexusVersion: string, contractVersion: number, drop: string[] = []) {
  const unsealed = {
    ...record,
    nexusVersion,
    contract: { ...record.contract, version: contractVersion },
    checks: record.checks
      .filter((check) => !drop.includes(check.name))
      .map((check) =>
        check.name.startsWith('declares support')
          ? { ...check, name: `declares support for nexus-ai-pro ${nexusVersion}` }
          : check,
      ),
  };
  unsealed.passed = unsealed.checks.every((check) => check.ok);
  return { ...unsealed, digest: recordDigest(unsealed) } as CompatibilityRecord;
}

test('a record seals what verify() proved: the contract, the release, the runtime, and the benchmark', async () => {
  const now = () => new Date('2026-10-20T08:00:00.000Z');
  const record = await memory.record(
    undefined,
    { embed },
    {
      package: '@acme/memory-vectors@1.2.0',
      repository: 'https://example.com/acme/memory-vectors',
      verify: './verify.mjs',
      now,
    },
  );
  assert.equal(record.format, 'nexus-compatibility/1');
  assert.deepEqual(record.adapter, {
    name: '@acme/memory-vectors',
    version: '1.2.0',
    kind: 'vector-store',
    nexus: '^2.4.0',
    capabilities: { filters: 'exact' },
    budgets: { search: 500 },
    package: '@acme/memory-vectors@1.2.0',
    repository: 'https://example.com/acme/memory-vectors',
    verify: './verify.mjs',
  });
  assert.deepEqual(record.contract, { kind: 'vector-store', version: ADAPTER_CONTRACTS['vector-store'].version });
  assert.equal(record.contract.version, 2, 'this release’s vector-store contract');
  assert.equal(record.nexusVersion, NEXUS_VERSION);
  assert.equal(record.verifiedAt, '2026-10-20T08:00:00.000Z');
  assert.match(record.runtime, /^node \d+\.\d+\.\d+ \w+ \w+$/);
  assert.equal(record.passed, true, JSON.stringify(record.checks.filter((check) => !check.ok)));
  assert.ok(record.checks.some((check) => check.name === 'adds a passage again under an id it deleted' && check.ok));
  assert.ok((record.benchmark.search?.calls ?? 0) > 0, 'search was measured');
  assert.match(record.digest, /^[0-9a-f]{64}$/);

  // Read back whole, from JSON text: key order does not matter, an edit does.
  const text = JSON.stringify(record);
  assert.deepEqual(readCompatibilityRecord(text), record);
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  assert.deepEqual(readCompatibilityRecord(reordered), record);
  assert.throws(
    () => readCompatibilityRecord({ ...record, passed: true, checks: [{ name: 'adds passages', ok: false }] }),
    (error: unknown) => error instanceof CompatibilityRecordError && /the digest does not match/.test(error.message),
  );
  const unsealedFailure = { ...record, checks: [{ name: 'adds passages', ok: false }] };
  assert.throws(
    () => readCompatibilityRecord({ ...unsealedFailure, digest: recordDigest(unsealedFailure) }),
    /passed does not follow from its checks/,
  );
  assert.throws(() => readCompatibilityRecord('{'), /not JSON/);
  assert.throws(() => readCompatibilityRecord([]), /a compatibility record is an object/);
  assert.throws(
    () => readCompatibilityRecord({ format: 'other/1', adapter: { kind: 'toString' } }),
    (error: unknown) => {
      assert.ok(error instanceof CompatibilityRecordError);
      for (const issue of [
        'format is "other/1"',
        'adapter.name is missing',
        'adapter.kind is not a kind',
        'contract names no version',
        'nexusVersion is missing',
        'passed is not true or false',
        'checks is not a list of checks',
        'benchmark is missing',
      ]) {
        assert.ok(
          error.issues.some((found) => found.startsWith(issue)),
          `names: ${issue}`,
        );
      }
      return true;
    },
  );

  // The same report sealed twice is the same record; any field changes the digest.
  const report = await memory.verify(undefined, { embed });
  const once = compatibilityRecord(report, { now, runtime: 'node 24.0.0 linux x64' });
  assert.equal(compatibilityRecord(report, { now, runtime: 'node 24.0.0 linux x64' }).digest, once.digest);
  assert.notEqual(compatibilityRecord(report, { now, runtime: 'node 22.0.0 linux x64' }).digest, once.digest);
});

test('a record’s state: passing, failing, outside the release’s range, or verified against an older contract', async () => {
  const record = await memory.record(undefined, { embed });
  assert.deepEqual(recordStatus(record), { state: 'passing', reasons: [], unverified: [] });

  const old = madeAgainst(record, '2.14.0', 1, ['adds a passage again under an id it deleted']);
  assert.deepEqual(recordStatus(old), {
    state: 'stale',
    reasons: ['verified against vector-store contract v1; v2 adds “adds a passage again under an id it deleted”'],
    unverified: ['adds a passage again under an id it deleted'],
  });
  assert.equal(recordStatus(old, { nexusVersion: '3.0.0' }).state, 'incompatible');
  assert.deepEqual(recordStatus(old, { nexusVersion: '3.0.0' }).reasons, [
    'declares nexus-ai-pro ^2.4.0, which leaves out 3.0.0',
  ]);

  const broken = madeAgainst(
    {
      ...record,
      checks: record.checks.map((check) =>
        check.name === 'accepts empty writes' ? { ...check, ok: false, detail: 'threw' } : check,
      ),
    },
    NEXUS_VERSION,
    2,
  );
  assert.deepEqual(recordStatus(broken), {
    state: 'failing',
    reasons: ['fails: accepts empty writes'],
    unverified: [],
  });

  // A store adapter's contract has one version: nothing is stale.
  const store = defineStoreAdapter({
    name: 'memory-store',
    version: '1.0.0',
    nexus: '>=2.4.0 <3',
    capabilities: {},
    create: () => new MemoryStore(),
  });
  assert.equal(recordStatus(await store.record(undefined, {})).state, 'passing');
});

test('two records of an adapter compare: what broke, what was added, what was fixed, and what slowed', async () => {
  const current = await memory.record(undefined, { embed });
  const listed = madeAgainst(current, '2.13.0', 1, ['adds a passage again under an id it deleted']);
  assert.deepEqual(compareRecords(listed, current), {
    adapter: '@acme/memory-vectors',
    broken: [],
    added: [{ name: 'adds a passage again under an id it deleted', ok: true }],
    fixed: [],
    slower: [],
    regressed: false,
  });

  const failing = madeAgainst(
    {
      ...current,
      checks: current.checks.map((check) =>
        check.name === 'accepts empty writes' ? { ...check, ok: false, detail: 'threw' } : check,
      ),
      benchmark: { ...current.benchmark, search: { calls: 3, p50Ms: 1, p95Ms: 50 } },
    },
    NEXUS_VERSION,
    2,
  );
  const fast = madeAgainst(
    { ...current, benchmark: { ...current.benchmark, search: { calls: 3, p50Ms: 1, p95Ms: 10 } } },
    NEXUS_VERSION,
    2,
  );
  const comparison = compareRecords(fast, failing);
  assert.deepEqual(comparison.broken, [{ name: 'accepts empty writes', detail: 'threw' }]);
  assert.deepEqual(comparison.slower, [{ operation: 'search', beforeMs: 10, afterMs: 50 }]);
  assert.equal(comparison.regressed, true);
  assert.deepEqual(compareRecords(failing, fast).fixed, ['accepts empty writes']);
  assert.equal(compareRecords(failing, fast).regressed, false);
  assert.equal(
    compareRecords(failing, failing).regressed,
    false,
    'a record already red is not turned red by this release',
  );
});

test('one page lists every record, by kind and name, the same records making the same page', async () => {
  const vectors = await memory.record(
    undefined,
    { embed },
    {
      repository: 'https://example.com/acme|vectors',
      now: () => new Date('2026-10-20T08:00:00Z'),
      runtime: 'node 24.21.0 linux x64',
    },
  );
  const store = defineStoreAdapter({
    name: '<memory-store>',
    version: '1.0.0',
    nexus: '>=2.4.0 <3',
    capabilities: {},
    create: () => new MemoryStore(),
  });
  const stored = await store.record(
    undefined,
    {},
    { now: () => new Date('2026-10-19T08:00:00Z'), runtime: 'node 22.16.0 win32 x64' },
  );
  const stale = madeAgainst(
    { ...vectors, adapter: { ...vectors.adapter, name: '@acme/older-vectors', repository: undefined } },
    '2.14.0',
    1,
    ['adds a passage again under an id it deleted'],
  );

  const page = compatibilityPage([vectors, stored, stale], { intro: 'Records submitted to this repository.' });
  assert.equal(
    compatibilityPage([stale, stored, vectors], { intro: 'Records submitted to this repository.' }),
    page,
    'order of input does not matter',
  );
  const lines = page.split('\n');
  assert.equal(lines[0], '# Adapter compatibility');
  assert.equal(lines[2], 'Records submitted to this repository.');
  assert.equal(lines[4], `States are judged against nexus-ai-pro ${NEXUS_VERSION}.`);
  assert.equal(
    lines[6],
    '| Adapter | Kind | Version | Verified against | Contract | State | Checks | p95 | Verified |',
  );
  const rows = lines.filter(
    (line) => line.startsWith('| ') && !line.startsWith('| Adapter') && !line.startsWith('| ---'),
  );
  assert.deepEqual(
    rows.map((row) => row.split(' | ')[0]),
    ['| <memory-store>', '| [@acme/memory-vectors](https://example.com/acme%7Cvectors)', '| @acme/older-vectors'],
    'store before vector-store, then by name; a | in a link is encoded, so the table holds',
  );
  assert.match(rows[0] as string, /\| store \| 1\.0\.0 \| \S+ \| v1 \| passing \| \d+\/\d+ \|/);
  assert.match(rows[2] as string, /\| vector-store \| 1\.2\.0 \| 2\.14\.0 \| v1 \| stale \|/);
  assert.match(rows[1] as string, /\| 2026-10-20, node 24\.21\.0 linux x64 \|$/);
  assert.match(rows[1] as string, / search \d+(\.\d+)? ms/);
  assert.equal((rows[1] as string).split(' | ').length, 9, 'nine cells');
  assert.match(
    page,
    /- \*\*@acme\/older-vectors\*\*: verified against vector-store contract v1; v2 adds “adds a passage again under an id it deleted”/,
  );

  const html = compatibilityPage([vectors, stored, stale], { format: 'html', title: 'Adapters & stores' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Adapters &#38; stores<\/title>/);
  assert.match(html, /<td>&#60;memory-store&#62;<\/td>/, 'escaped');
  assert.match(html, /<tr data-state="stale">/);
  assert.match(html, /<a href="https:\/\/example.com\/acme\|vectors">@acme\/memory-vectors<\/a>/);
});

test('proof: a contract change an adapter does not meet turns its record red before the release that makes it', async () => {
  const kit = pathToFileURL(path.resolve('src/adapter-kit/index.ts')).href;
  const repository = await mkdtemp(path.join(tmpdir(), 'nexus-adapter-'));
  try {
    // The adapter's own repository: its source, and its verify module.
    await writeFile(
      path.join(repository, 'package.json'),
      JSON.stringify({ name: '@community/tombstone-vectors', version: '0.4.0', type: 'module' }),
    );
    await writeFile(path.join(repository, 'verify.mjs'), adapterSource(kit, '0.4.0', true));

    // Its own CI, on this release: the published command writes a record that does not pass, and says why.
    const verified = nexus(
      [
        'verify',
        './verify.mjs',
        '--out',
        'records/tombstone-vectors.json',
        '--package',
        '@community/tombstone-vectors@0.4.0',
      ],
      repository,
    );
    assert.equal(verified.status, 1, `it fails against this release: ${verified.stdout}${verified.stderr}`);
    assert.match(verified.stdout, /adds a passage again under an id it deleted\s+FAILED\s+the passage stays deleted/);
    assert.match(verified.stdout, /@community\/tombstone-vectors@0\.4\.0 did not pass the vector-store contract v2/);
    const written = readCompatibilityRecord(
      await readFile(path.join(repository, 'records/tombstone-vectors.json'), 'utf8'),
    );
    assert.equal(written.passed, false);
    assert.equal(written.adapter.verify, '../verify.mjs', 'the module, from where the record is');
    assert.equal(written.adapter.package, '@community/tombstone-vectors@0.4.0');
    assert.equal(
      written.adapter.repository,
      'https://example.com/community/tombstone-vectors',
      'from the module’s own record options',
    );

    // The record it listed when 2.14 was current: contract v1, which it passed.
    const registry = path.join(repository, 'registry');
    await mkdir(registry);
    const listed = madeAgainst(
      { ...written, checks: written.checks.map((check) => ({ ...check, ok: true, detail: undefined })) },
      '2.14.0',
      1,
      ['adds a passage again under an id it deleted'],
    );
    assert.equal(listed.passed, true);
    await writeFile(path.join(registry, 'tombstone-vectors.json'), JSON.stringify(listed, null, 2));

    // The page shows it as stale; --check lets a stale record through, --strict does not.
    const pageCheck = nexus(['page', 'registry', '--check'], repository);
    assert.equal(pageCheck.status, 0, pageCheck.stdout + pageCheck.stderr);
    assert.match(
      pageCheck.stdout,
      /\| \[@community\/tombstone-vectors\]\(https:\/\/example.com\/community\/tombstone-vectors\) \| vector-store \| 0\.4\.0 \| 2\.14\.0 \| v1 \| stale \|/,
    );
    const strict = nexus(['page', 'registry', '--strict'], repository);
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /@community\/tombstone-vectors: stale: verified against vector-store contract v1/);

    // Before this release ships, the listed adapter is verified again against it: red, naming the check.
    const caught = nexus(['recheck', 'registry'], repository);
    assert.equal(caught.status, 1, `the release is held back: ${caught.stdout}${caught.stderr}`);
    assert.match(
      caught.stdout,
      /@community\/tombstone-vectors@0\.4\.0\s+2\.14\.0, contract v1, passed\s+\S+, contract v2, failed\s+REGRESSED/,
    );
    assert.match(
      caught.stdout,
      /fails the new check “adds a passage again under an id it deleted” \(the passage stays deleted\)/,
    );
    const json = nexus(['recheck', 'registry', '--json'], repository);
    const report = JSON.parse(json.stdout) as {
      regressed: boolean;
      results: Array<{ comparison: { added: Array<{ name: string; ok: boolean }> } }>;
    };
    assert.equal(report.regressed, true);
    assert.ok(
      report.results[0]?.comparison.added.some(
        (check) => check.name === 'adds a passage again under an id it deleted' && !check.ok,
      ),
    );

    // The adapter fixes the bug: verified again, it passes, and recheck --update keeps the new record.
    await writeFile(path.join(repository, 'verify.mjs'), adapterSource(kit, '0.4.1', false));
    const fixed = nexus(['recheck', 'registry', '--update'], repository);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    assert.match(fixed.stdout, /passing/);
    const updated = readCompatibilityRecord(await readFile(path.join(registry, 'tombstone-vectors.json'), 'utf8'));
    assert.deepEqual([updated.adapter.version, updated.contract.version, updated.passed], ['0.4.1', 2, true]);
    const page = nexus(['page', 'registry', '--out', 'COMPATIBILITY.md'], repository);
    assert.equal(page.status, 0);
    const expect = nexus(['page', 'registry', '--expect', 'COMPATIBILITY.md'], repository);
    assert.equal(expect.status, 0, 'the page lists the records as they are');
    await writeFile(path.join(registry, 'second.json'), JSON.stringify(written, null, 2));
    const drifted = nexus(['page', 'registry', '--expect', 'COMPATIBILITY.md'], repository);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stdout, /COMPATIBILITY\.md does not list these records as they are/);

    // A record edited by hand is refused; a module that exports no adapter is a usage error.
    await writeFile(path.join(registry, 'second.json'), JSON.stringify({ ...written, passed: true }));
    const edited = nexus(['page', 'registry'], repository);
    assert.equal(edited.status, 2);
    assert.match(edited.stderr, /second\.json: Not a valid compatibility record: the digest does not match/);
    await writeFile(path.join(repository, 'empty.mjs'), 'export const nothing = 1;');
    const empty = nexus(['verify', './empty.mjs'], repository);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /must export an adapter built with the adapter kit as `adapter`/);
    const usage = nexus(['list'], repository);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Unknown adapters command "list"/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
