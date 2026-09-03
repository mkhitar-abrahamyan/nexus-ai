import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_ALIAS_METADATA,
  GENERATED_MODELS,
  GENERATED_MODEL_ALIASES,
  GENERATED_MODEL_COUNT,
  GENERATED_REGISTRY_PROVENANCE,
} from '../src/models/generated.js';
import { KNOWN_MODELS, MODEL_ALIASES, MODEL_ALIAS_METADATA, REGISTRY_PROVENANCE } from '../src/types/providers.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Drops keys whose value is `undefined`.
 *
 * The hand-written registry writes `notes: undefined` on some entries; JSON omits the key entirely.
 * Those are the same thing to every consumer, so comparing raw objects would report a difference
 * that does not exist. Everything else is compared exactly.
 */
function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child !== undefined) result[key] = withoutUndefined(child);
  }
  return result as T;
}

test('the generated registry matches the hand-written one exactly', () => {
  // The runtime still reads KNOWN_MODELS. This is the drift check that makes the eventual swap
  // safe: if the two ever disagree, one of them is wrong and this says so before a release.
  assert.deepEqual(withoutUndefined(GENERATED_MODELS), withoutUndefined(KNOWN_MODELS));
  assert.deepEqual(withoutUndefined(GENERATED_MODEL_ALIASES), withoutUndefined(MODEL_ALIASES));
  assert.deepEqual(withoutUndefined(GENERATED_ALIAS_METADATA), withoutUndefined(MODEL_ALIAS_METADATA));
  assert.deepEqual({ ...GENERATED_REGISTRY_PROVENANCE }, { ...REGISTRY_PROVENANCE });
});

test('the generated count matches the generated map', () => {
  assert.equal(GENERATED_MODEL_COUNT, Object.keys(GENERATED_MODELS).length);
  assert.ok(GENERATED_MODEL_COUNT > 90, 'the registry should not have silently shrunk');
});

test('generated entries are sorted, so a data diff is readable', () => {
  const names = Object.keys(GENERATED_MODELS);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
  );
});

test('every generated model declares the fields routing and pricing depend on', () => {
  for (const [name, capabilities] of Object.entries(GENERATED_MODELS)) {
    assert.ok(Array.isArray(capabilities.modalities), `${name}: modalities`);
    assert.equal(typeof capabilities.streaming, 'boolean', `${name}: streaming`);
    assert.equal(typeof capabilities.toolCalling, 'boolean', `${name}: toolCalling`);
    assert.ok(capabilities.maxContextTokens > 0, `${name}: maxContextTokens`);
    assert.ok(capabilities.costPer1kInput >= 0, `${name}: costPer1kInput`);
    assert.ok(capabilities.costPer1kOutput >= 0, `${name}: costPer1kOutput`);
  }
});

test('every generated alias points at a model that exists', () => {
  for (const [alias, target] of Object.entries(GENERATED_MODEL_ALIASES)) {
    const normalized = target.startsWith('ollama/') ? target.slice(7) : target;
    assert.ok(
      GENERATED_MODELS[target] || GENERATED_MODELS[normalized],
      `alias "${alias}" points at unknown model "${target}"`,
    );
  }
});

test('the generator reports the committed output as current', () => {
  // Equivalent to the registry:check CI gate: committed data and committed output cannot drift.
  const output = execFileSync(process.execPath, ['scripts/generate-model-registry.mjs', '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(output, /Model registry is current/);
});
