import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { ResponseFormatError, applyResponseFormat } from '../src/core/response-format.js';
import { BudgetExceededError } from '../src/core/lifecycle.js';
import { budgetLedger } from '../src/lifecycle/budget.js';
import { SchemaValidator } from '../src/security/schema-validator.js';
import { MemoryTenantUsage } from '../src/server/tenancy.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const response = (content: string): NexusResponse => ({
  content,
  role: 'assistant',
  finishReason: 'stop',
  meta: {
    requestId: 'r1',
    providerUsed: 'mock',
    modelUsed: 'mock',
    latencyMs: 1,
    tokensInput: 1,
    tokensOutput: 1,
    tokensSaved: 0,
    cacheHit: false,
    guardrailsApplied: [],
  },
});

// ── Optional validators ────────────────────────────────────────────

test('nothing the package runs imports zod, ajv, or ajv-formats at module level', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };
  assert.equal(pkg.dependencies, undefined, 'the package has no required dependencies');
  for (const name of ['zod', 'ajv', 'ajv-formats', '@types/node']) {
    assert.equal(pkg.peerDependenciesMeta[name]?.optional, true, `${name} is an optional peer`);
  }
  for (const file of ['src/core/response-format.ts', 'src/security/schema-validator.ts']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /^import (?!type)[^;]*from '(zod|ajv|ajv-formats)'/m,
      `${file} loads no validator eagerly`,
    );
  }
});

test('a zod shape is checked through its own safeParse, with no zod import of ours', async () => {
  const schema = { answer: z.string(), score: z.number().min(0).max(10) };
  const ok = await applyResponseFormat(response('{"answer":"yes","score":7,"extra":true}'), {
    type: 'json_schema',
    schema,
  });
  assert.equal(ok.content, '{"answer":"yes","score":7,"extra":true}', 'fields the shape does not name pass through');

  await assert.rejects(
    () => applyResponseFormat(response('{"answer":3,"score":11}'), { type: 'json_schema', schema }),
    (error: unknown) =>
      error instanceof ResponseFormatError && /\$\.answer/.test(error.message) && /\$\.score/.test(error.message),
  );
  await assert.rejects(
    () => applyResponseFormat(response('[1,2]'), { type: 'json_schema', schema }),
    /\$ must be an object/,
  );
});

test('a JSON Schema loads ajv on first use and is compiled once', async () => {
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
  await applyResponseFormat(response('{"ok":true}'), { type: 'json_schema', schema });
  await assert.rejects(
    () => applyResponseFormat(response('{"ok":"no"}'), { type: 'json_schema', schema }),
    /\$\/ok must be boolean/,
  );
});

test('the request check reports every field that does not match, by path', () => {
  const findings = new SchemaValidator().validate({
    model: '',
    messages: [
      { role: 'robot', content: 'hi' },
      { role: 'user', content: [{ type: 'image', source: 'not-an-object' }, { type: 'text' }] },
    ],
    tools: [{ name: 'lookup', description: '', parameters: {} }],
    temperature: 3,
    maxTokens: 1.5,
    stop: [1],
  } as unknown as CompletionRequest);

  assert.deepEqual(
    findings.map((finding) => finding.path),
    [
      'model',
      'messages.0.role',
      'messages.1.content.0.source',
      'messages.1.content.1.text',
      'tools.0.description',
      'temperature',
      'maxTokens',
      'stop',
    ],
  );
  assert.ok(findings.every((finding) => finding.type === 'schema' && finding.severity === 'high'));
  assert.deepEqual(
    new SchemaValidator().validate({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    [],
  );
});

// ── The budget ledger ──────────────────────────────────────────────

const operation = { family: 'completion' as const, operation: 'complete', requestId: 'r1' };

test('a ledger refuses an estimate past its limit and a spent budget, and resets each period', async () => {
  let now = new Date('2026-10-01T10:00:00Z');
  const ledger = budgetLedger({ limit: 1, period: 'day', now: () => now });

  const held = await ledger.reserve(operation, 0.6);
  assert.ok(held);
  await assert.rejects(async () => ledger.reserve(operation, 0.6), BudgetExceededError);
  await ledger.reconcile(held, 1);
  assert.equal(await ledger.spent('default'), 1);
  await assert.rejects(async () => ledger.reserve(operation, 0), BudgetExceededError, 'spent means spent');

  now = new Date('2026-10-02T00:00:01Z');
  assert.equal(await ledger.spent('default'), 0, 'a new day starts empty');
  assert.ok(await ledger.reserve(operation, 0.5));
});

test('a ledger keeps its totals in any tenant usage store, and leaves untracked work alone', async () => {
  const store = new MemoryTenantUsage();
  const ledger = budgetLedger({
    limit: 2,
    store,
    key: (op) => (op.family === 'completion' ? op.tenantId : undefined),
  });
  const reservation = await ledger.reserve({ ...operation, tenantId: 'acme' }, 0.5);
  assert.ok(reservation);
  assert.equal(await ledger.spent('acme'), 0.5);
  await ledger.release(reservation);
  assert.equal(await ledger.spent('acme'), 0);
  assert.equal(await ledger.reserve({ ...operation, family: 'image' }, 100), undefined, 'not tracked, so not refused');
});
