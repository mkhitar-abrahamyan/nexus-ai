import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSignals } from '../src/utils/signals.js';

test('a linked signal aborts with the first source, and a disposed one no longer follows its sources', () => {
  const run = new AbortController();
  const step = new AbortController();
  const linked = linkSignals([run.signal, undefined, step.signal]);
  step.abort('step failed');
  assert.equal(linked.signal.aborted, true);
  assert.equal(linked.signal.reason, 'step failed');

  const shared = new AbortController();
  const attempt = linkSignals([shared.signal, new AbortController().signal]);
  attempt.dispose();
  attempt.dispose();
  shared.abort('too late');
  assert.equal(attempt.signal.aborted, false, 'the run signal no longer reaches a finished attempt');

  const single = new AbortController().signal;
  assert.equal(linkSignals([single, undefined]).signal, single, 'one signal is returned as it is');
  const gone = new AbortController();
  gone.abort('already');
  assert.equal(linkSignals([gone.signal, new AbortController().signal]).signal.reason, 'already');
});
