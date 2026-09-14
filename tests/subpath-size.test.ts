import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertWithinCostBudget, CostBudgetError, DEFAULT_CURRENCY, formatCost } from '../src/optimizer/cost.js';
import {
  assertWithinCostBudget as budgetAssert,
  CostBudgetError as BudgetError,
} from '../src/optimizer/cost-budget.js';
import type { CostEstimate } from '../src/types/planning.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function estimate(totalCost: number): CostEstimate {
  return {
    model: 'gpt-5.4-mini',
    inputTokens: 100,
    outputTokens: 10,
    inputCost: totalCost,
    outputCost: 0,
    totalCost,
    currency: 'USD',
    formatted: formatCost(totalCost),
  };
}

// ── The split kept the public surface identical ────────────────────

test('optimizer/cost still exports everything it used to', () => {
  // The split is internal; an existing import of optimizer/cost must not notice it.
  assert.equal(DEFAULT_CURRENCY, 'USD');
  assert.equal(formatCost(1.5), '$1.5000');
  assert.equal(typeof assertWithinCostBudget, 'function');
  assert.equal(CostBudgetError, BudgetError, 're-export must be the same class, not a copy');
  assert.equal(assertWithinCostBudget, budgetAssert);
});

test('a budget under the estimate throws, over it passes', () => {
  assert.doesNotThrow(() => assertWithinCostBudget(estimate(0.5), 1));
  assert.doesNotThrow(() => assertWithinCostBudget(estimate(0.5)), 'no budget means no limit');
  assert.throws(() => assertWithinCostBudget(estimate(2), 1), CostBudgetError);
});

test('an error thrown from either module is catchable as the same type', () => {
  // A consumer catching CostBudgetError imported from the root must still catch it.
  try {
    budgetAssert(estimate(5), 1);
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof CostBudgetError);
  }
});

// ── The measured property this release exists to protect ───────────

/** Files Node loads when an entry point is imported, following static imports only. */
function importGraph(entryFile: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    seen.add(file);
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1] as string;
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      stack.push(resolved.endsWith('.js') ? resolved : `${resolved}.js`);
    }
  }
  return seen;
}

function graphFor(relativeEntry: string): { files: Set<string>; kb: number } {
  const files = importGraph(path.join(repoRoot, relativeEntry));
  let bytes = 0;
  for (const file of files) {
    try {
      bytes += statSync(file).size;
    } catch {
      // Type-only modules emit no JS.
    }
  }
  return { files, kb: Math.round(bytes / 1024) };
}

const registryFile = path.join(repoRoot, 'dist', 'types', 'providers.js');

test('the embeddings entry point does not load the completion model catalogue', () => {
  // This is the regression the release exists to prevent: embeddings only enforces a cost budget,
  // which compares two numbers, yet used to drag 30 KB of chat-model data in to do it.
  const { files } = graphFor('dist/embeddings/index.js');
  assert.equal(files.has(registryFile), false, 'embeddings must not reach types/providers.js');
});

test('cost-budget carries no registry dependency at all', () => {
  const { files, kb } = graphFor('dist/optimizer/cost-budget.js');
  assert.equal(files.has(registryFile), false);
  assert.ok(kb <= 4, `budget enforcement should be tiny, measured ${kb} KB`);
});

test('pricing still reaches the catalogue, because it genuinely needs prices', () => {
  const { files } = graphFor('dist/optimizer/cost.js');
  assert.equal(files.has(registryFile), true, 'estimateCost needs model prices; that cost is real');
});

test('every exported subpath has a recorded size budget', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const budget = JSON.parse(readFileSync(path.join(repoRoot, 'size-budget.json'), 'utf8'));

  for (const subpath of Object.keys(packageJson.exports)) {
    assert.ok(budget.maxKb[subpath] !== undefined, `${subpath} has no size budget. Run: npm run size:update`);
  }
});

test('the smallest entry points stay genuinely small', () => {
  // The claim the README makes. If these grow, the positioning is no longer true.
  for (const [entry, maxKb] of [
    ['dist/core/streaming.js', 4],
    ['dist/cache/memory-cache.js', 6],
    ['dist/ops/circuit-breaker.js', 12],
  ] as const) {
    const { kb } = graphFor(entry);
    assert.ok(kb <= maxKb, `${entry} is ${kb} KB, above the ${maxKb} KB this test pins`);
  }
});
