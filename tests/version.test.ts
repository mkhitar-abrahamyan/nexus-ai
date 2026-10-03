import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NEXUS_VERSION } from '../src/version.js';

test('the version experiments record matches package.json', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  assert.equal(NEXUS_VERSION, pkg.version, 'bump src/version.ts with package.json');
});
