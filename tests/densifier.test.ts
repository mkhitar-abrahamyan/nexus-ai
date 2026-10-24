/**
 * The prompt densifier: shorter text that says the same, a code block left as it is, with its fences
 * on lines of their own, and a phrase replaced only where it stands as whole words.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PromptDensifier } from '../src/optimizer/densifier.js';
import { OpenTelemetryTraceExporter } from '../src/ops/otel-tracing.js';
import type { CompletionRequest } from '../src/types/messages.js';

const densifier = new PromptDensifier();
const all = ['whitespace-cleanup', 'phrase-compression', 'list-compaction'];
const densify = (text: string, techniques = all, preserveCodeBlocks?: boolean) => {
  const applied = new Set<string>();
  const output = densifier.densifyText(
    text,
    techniques,
    applied,
    preserveCodeBlocks === undefined ? {} : { preserveCodeBlocks },
  );
  return { output, applied: [...applied].sort() };
};

test('whitespace is cleaned up, and the text trimmed at its ends only', () => {
  assert.deepEqual(densify('  Hello   there\t friend  \n\n\n\nBye  ', ['whitespace-cleanup']), {
    output: 'Hello there friend\n\nBye',
    applied: ['whitespace-cleanup'],
  });
  assert.deepEqual(densify('Already tidy.', ['whitespace-cleanup']), { output: 'Already tidy.', applied: [] });
});

test('a code block is left as it is, its fences on lines of their own', () => {
  const text = 'Run this:   \n```js\nconst  x =   1;\n```\nThen   check.';
  const { output } = densify(text);
  assert.equal(output, 'Run this:\n```js\nconst  x =   1;\n```\nThen check.', 'the fences still open and close lines');
  assert.match(output, /\n```js\n/, 'a fence the start of a line, so it is still a code block');
  // Asked not to keep code blocks, they are densified too.
  assert.equal(densify(text, ['whitespace-cleanup'], false).output, 'Run this:\n```js\nconst x = 1;\n```\nThen check.');
});

test('a wordy phrase is shortened where it stands as whole words, a capital kept', () => {
  assert.deepEqual(
    densify('Please make sure that it runs. In order to start, you should wait.', ['phrase-compression']),
    {
      output: 'Ensure it runs. To start, do wait.',
      applied: ['phrase-compression'],
    },
  );
  assert.equal(
    densify('We met in order today, and you shouldn’t worry; reply as soon as possible.', ['phrase-compression'])
      .output,
    'We met in order today, and you shouldn’t worry; reply ASAP.',
    'not inside "today", nor "shouldn’t"',
  );
  assert.equal(
    densify('Due to the fact that it rained, at this point in time we wait.', ['phrase-compression']).output,
    'Because it rained, now we wait.',
  );
  assert.equal(densify('It is important to rest.', ['phrase-compression']).output, 'Must rest.');
});

test('lists are compacted, and only the techniques asked for run', () => {
  assert.deepEqual(densify('Items:\n   *   one\n\n  - two', ['list-compaction']), {
    output: 'Items:\n- one\n- two',
    applied: ['list-compaction'],
  });
  assert.deepEqual(densify('in order to   go', ['list-compaction']), { output: 'in order to   go', applied: [] });
});

test('a request is densified message by message, its text parts only, and the original left alone', () => {
  const request: CompletionRequest = {
    model: 'm',
    messages: [
      { role: 'system', content: 'You should   answer briefly.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'In order to   help,  look:' },
          { type: 'image', source: { url: 'https://example.com/a.png' } },
        ],
      },
    ],
  };
  const copy = structuredClone(request);
  const { request: next, techniques } = densifier.densifyRequest(request);
  assert.deepEqual(request, copy, 'the original unchanged');
  assert.equal(next.messages[0]?.content, 'Do answer briefly.');
  const parts = next.messages[1]?.content as Array<{ type: string; text?: string }>;
  assert.equal(parts[0]?.text, 'To help, look:');
  assert.deepEqual(parts[1], { type: 'image', source: { url: 'https://example.com/a.png' } });
  assert.deepEqual(techniques.sort(), ['phrase-compression', 'whitespace-cleanup']);
  assert.deepEqual(densifier.densifyRequest(request, { enabled: false }), { request, techniques: [] }, 'off, nothing');
});

test('a pipeline trace becomes a span for the pipeline and one per step, failures recorded as errors', () => {
  const spans: Array<{
    name: string;
    options?: Record<string, unknown>;
    attributes: Record<string, unknown>;
    status?: { code: number; message?: string };
    exceptions: string[];
    ended?: Date | undefined;
  }> = [];
  const tracer = {
    startSpan(name: string, options?: Record<string, unknown>) {
      const span = {
        name,
        ...(options ? { options } : {}),
        attributes: {} as Record<string, unknown>,
        exceptions: [] as string[],
      } as (typeof spans)[number];
      spans.push(span);
      return {
        setAttribute: (key: string, value: string | number | boolean) => {
          span.attributes[key] = value;
        },
        recordException: (error: Error) => {
          span.exceptions.push(error.message);
        },
        setStatus: (status: { code: number; message?: string }) => {
          span.status = status;
        },
        end: (time?: Date) => {
          span.ended = time;
        },
      };
    },
  };
  new OpenTelemetryTraceExporter(tracer, 'shop').exportTrace(
    {
      requestId: 'req-1',
      startedAt: '2026-10-24T10:00:00.000Z',
      endedAt: '2026-10-24T10:00:01.000Z',
      durationMs: 1_000,
      steps: [
        {
          name: 'inputSecurity',
          startedAt: '2026-10-24T10:00:00.000Z',
          endedAt: '2026-10-24T10:00:00.100Z',
          durationMs: 100,
          ok: true,
          metadata: { checks: 3, mode: 'strict', nested: { skipped: true } },
        },
        {
          name: 'providerCall',
          startedAt: '2026-10-24T10:00:00.100Z',
          endedAt: '2026-10-24T10:00:01.000Z',
          durationMs: 900,
          ok: false,
          error: 'timed out',
        },
      ],
    },
    { 'service.name': 'checkout' },
  );
  assert.deepEqual(
    spans.map((span) => span.name),
    ['shop.pipeline', 'shop.inputSecurity', 'shop.providerCall'],
  );
  const [root, guardrails, provider] = spans;
  assert.deepEqual(root?.options, { startTime: new Date('2026-10-24T10:00:00.000Z') });
  assert.deepEqual(root?.attributes, {
    'service.name': 'checkout',
    'pipeline.duration_ms': 1_000,
    'request.id': 'req-1',
  });
  assert.deepEqual(root?.ended, new Date('2026-10-24T10:00:01.000Z'));
  assert.deepEqual(
    guardrails?.attributes,
    {
      'service.name': 'checkout',
      'pipeline.step': 'inputSecurity',
      'pipeline.step.ok': true,
      'pipeline.step.duration_ms': 100,
      'pipeline.step.checks': 3,
      'pipeline.step.mode': 'strict',
    },
    'metadata that is not a string, number, or boolean is left out',
  );
  assert.deepEqual(guardrails?.status, { code: 1 });
  assert.deepEqual(guardrails?.ended, new Date('2026-10-24T10:00:00.100Z'));
  assert.deepEqual(provider?.status, { code: 2, message: 'timed out' });
  assert.deepEqual(provider?.exceptions, ['timed out']);

  // A trace not yet ended ends its root without a time; the default prefix is the package's.
  const unfinished: string[] = [];
  new OpenTelemetryTraceExporter({
    startSpan: (name) => {
      unfinished.push(name);
      return { setAttribute: () => undefined, end: (time?: Date) => unfinished.push(String(time)) };
    },
  }).exportTrace({ startedAt: '2026-10-24T10:00:00.000Z', steps: [] });
  assert.deepEqual(unfinished, ['nexus-ai-pro.pipeline', 'undefined']);
});
