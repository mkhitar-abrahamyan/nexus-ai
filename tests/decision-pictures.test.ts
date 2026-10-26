/**
 * Decisions about pictures: the pictures a state holds, each named by its path; a box question, its
 * answer checked and judged by overlap; a picture keyed, traced, and budgeted without its bytes;
 * TypeSafe AI's assets and images header against a stand-in written from its documentation; a vision
 * model shown each picture by its path, its box read from samples; and the proof that one decision
 * suite passes on pictures, on both, with a box landing where the picture has it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCacheAdapter } from '../src/cache/adapters.js';
import { NexusAI } from '../src/core/nexus.js';
import {
  answeredRight,
  answerProbability,
  boxOverlap,
  type CachedDecision,
  calibrate,
  completionDecisions,
  type DecisionBox,
  type DecisionConformanceCase,
  DecisionError,
  type DecisionErrorCode,
  DecisionManager,
  type DecisionProvider,
  type DecisionQuestions,
  decide,
  decisionAnswer,
  decisionEvaluator,
  readPicture,
  runDecisionConformance,
  statePictures,
} from '../src/decisions/index.js';
import { MockDecisionProvider } from '../src/decisions/mock.js';
import { TypeSafeDecisionProvider } from '../src/decisions/typesafe.js';
import { budgetLedger } from '../src/lifecycle/budget.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { EvaluationContext, EvaluationScore } from '../src/types/evaluate.js';
import type { CompletionRequest, ContentPart, ImageContent } from '../src/types/messages.js';
import type { NexusResponse, TokenLogprob } from '../src/types/response.js';
import { animatedPng, look, type Scene, scenePng, type Seen } from './pictures.js';
import { type Judged, type JudgedBox, type StandInPicture, typesafeStandIn, type WireQuestion } from './typesafe.js';

const close = (actual: number, expected: number, message: string, within = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= within, `${message}: expected ${expected}, got ${actual}`);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A scene as an image part, its PNG held as base64. */
const picture = (scene: Scene): ImageContent => ({
  type: 'image',
  source: { base64: base64(scenePng(scene)), mimeType: 'image/png' },
});

/** Scenes whose marks are known. */
const RED: Scene = { width: 640, height: 480, mark: { colour: 'red', top: 80, bottom: 200, left: 120, right: 240 } };
const BLUE: Scene = { width: 400, height: 400, mark: { colour: 'blue', top: 40, bottom: 80, left: 300, right: 340 } };
const GREEN: Scene = { width: 500, height: 500, mark: { colour: 'green', top: 50, bottom: 450, left: 50, right: 450 } };
const BLANK: Scene = { width: 800, height: 600 };

/** Where a scene's mark is, as a decision's box. */
function boxOf(scene: Scene): DecisionBox {
  const mark = scene.mark as NonNullable<Scene['mark']>;
  return {
    top: mark.top / scene.height,
    bottom: mark.bottom / scene.height,
    left: mark.left / scene.width,
    right: mark.right / scene.width,
  };
}

/** The value at a path in a state, as a question writes it: `photo`, `faces.happy`, or `frames[2].frame`. */
function at(state: unknown, path: string): unknown {
  return path
    .split(/\.|\[(\d+)\]/)
    .filter(Boolean)
    .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], state);
}

/** How a reader of pictures answers, the same whichever backend serves it; with no picture, as it reads text. */
function reads(seen: Seen | undefined, kind: 'yes-no' | 'choice' | 'score' | 'box', options: string[]): Judged {
  const rest = (count: number) => 0.1 / Math.max(1, count - 1);
  if (kind === 'box') {
    return { box: seen?.box ?? { top: 0, bottom: 1, left: 0, right: 1 }, confidence: seen?.box ? 0.9 : 0.1 };
  }
  if (!seen) {
    if (kind === 'yes-no') return 0.9;
    if (kind === 'choice')
      return Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.9 : rest(options.length)]));
    return options.map((_, index) => (index === options.length - 1 ? 0.9 : rest(options.length)));
  }
  if (kind === 'yes-no') return seen.box ? 0.95 : 0.05;
  if (kind === 'choice') {
    return Object.fromEntries(options.map((option) => [option, option === seen.colour ? 0.9 : rest(options.length)]));
  }
  const level = seen.covers < 0.1 ? 0 : seen.covers < 1 / 3 ? 1 : 2;
  return options.map((_, index) => (index === level ? 0.9 : rest(options.length)));
}

/** TypeSafe AI's model, as the stand-in serves it: it looks at the picture the question names. */
function typesafeJudge(
  state: unknown,
  _name: string,
  question: WireQuestion,
  pictures: Record<string, StandInPicture>,
): Judged {
  const path = /`([^`]+)`/.exec(String(question.instructions ?? ''))?.[1];
  const reference = path === undefined ? undefined : at(state, path);
  const shown = typeof reference === 'string' ? pictures[reference] : undefined;
  const kind = question.type === 'noul' ? 'yes-no' : (question.type as 'choice' | 'score' | 'box');
  const options =
    question.type === 'choice'
      ? Object.keys(question.criteria as object)
      : question.type === 'score'
        ? (question.criteria as string[])
        : [];
  return reads(shown ? look(shown.bytes) : undefined, kind, options);
}

/** A picture part's bytes, however it holds them. */
function bytesOf(part: ImageContent): Uint8Array {
  const source = part.source as Record<string, unknown>;
  if (typeof source.base64 === 'string') return new Uint8Array(Buffer.from(source.base64, 'base64'));
  if (source.buffer instanceof Uint8Array) return source.buffer;
  return (source.asset as { location: { data: Uint8Array } }).location.data;
}

/**
 * A vision model behind a completion client: it reads each picture under the path its label gives,
 * answers codes with their log probabilities, and a box with a little jitter between samples. A blind
 * one reads only the text.
 */
function visionModel(options: { blind?: boolean } = {}) {
  const requests: CompletionRequest[] = [];
  let sample = 0;
  return {
    requests,
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      requests.push(request);
      request.signal?.throwIfAborted();
      const content = request.messages[1]?.content ?? '';
      const parts: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      const shown = new Map<string, Uint8Array>();
      let label: string | undefined;
      for (const part of parts) {
        if (part.type === 'text') label = /^`(.+)`:$/.exec(part.text)?.[1];
        else if (part.type === 'image' && label !== undefined && !options.blind) shown.set(label, bytesOf(part));
      }
      const asked = (parts.at(-1) as { text: string }).text;
      const path = /`([^`]+)`/.exec(asked)?.[1];
      const bytes = path === undefined ? undefined : shown.get(path);
      const seen = bytes ? look(bytes) : undefined;
      const meta = {} as NexusResponse['meta'];
      if (asked.includes('Answer with four numbers')) {
        sample += 1;
        const { box } = reads(seen, 'box', []) as JudgedBox;
        const jitter = ((sample % 3) - 1) * 0.001;
        const edge = (value: number) => Math.min(1, Math.max(0, value + jitter)).toFixed(4);
        return {
          content: `${edge(box.top)} ${edge(box.bottom)} ${edge(box.left)} ${edge(box.right)}`,
          role: 'assistant',
          finishReason: 'stop',
          meta,
        };
      }
      const codes = (/Answer with one code: (.*)\./.exec(asked)?.[1] ?? '').split(', ');
      const kind = codes[0] === 'Y' ? 'yes-no' : codes[0] === '0' ? 'score' : 'choice';
      const names =
        kind === 'choice'
          ? [...asked.matchAll(/^[A-Z]: ([^,\n]+)/gm)].map((match) => (match[1] as string).trim())
          : codes;
      const judged = reads(seen, kind, names);
      const weights =
        typeof judged === 'number'
          ? [judged, 1 - judged]
          : Array.isArray(judged)
            ? judged
            : names.map((name) => (judged as Record<string, number>)[name] ?? 0);
      const logprobs: TokenLogprob[] = [
        {
          token: codes[0] as string,
          logprob: Math.log(weights[0] || 1e-9),
          top: codes.map((code, index) => ({ token: code, logprob: Math.log(weights[index] || 1e-9) })),
        },
      ];
      return { content: codes[0] as string, role: 'assistant', finishReason: 'stop', logprobs, meta };
    },
  };
}

/** Rejects with a `DecisionError` of this code, whose message matches. */
const refused = (promise: Promise<unknown>, code: DecisionErrorCode, message: RegExp) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DecisionError, `a DecisionError, not ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.match(error.message, message);
    return true;
  });

const marked = { type: 'yes-no', question: 'Is there a mark in `photo`?' } as const;
const where = { type: 'box', question: 'the mark in `photo`' } as const;
const colour = {
  type: 'choice',
  question: 'What colour is the mark in `photo`?',
  options: ['red', 'green', 'blue'],
} as const;

test('the pictures a state holds are found by their paths, and read with the media readers', async () => {
  const red = picture(RED);
  const asset = {
    type: 'asset' as const,
    asset: { mimeType: 'image/png', location: { kind: 'bytes' as const, data: scenePng(BLUE) } },
  };
  const state = {
    note: 'Claim 7',
    photo: red,
    faces: { happy: red },
    frames: [{}, {}, { frame: asset }],
    recording: { type: 'audio', source: { base64: 'AAAA' } },
    raw: new Uint8Array([1, 2, 3]),
  };
  assert.deepEqual(
    statePictures(state).map((found) => found.path),
    ['photo', 'faces.happy', 'frames[2].frame'],
    'every picture by its path, one used twice at both, and audio and bytes passed by',
  );
  const looped: Record<string, unknown> = { photo: red };
  looped.self = looped;
  assert.deepEqual(
    statePictures(looped).map((found) => found.path),
    ['photo'],
    'a state that holds itself is not followed round',
  );
  assert.deepEqual(statePictures({ note: 'x', list: [1, { a: 2 }] }), [], 'a state without pictures has none');

  const read = await readPicture(statePictures(state)[2] as never);
  assert.deepEqual([read.mimeType, read.width, read.height], ['image/png', 400, 400], 'an asset’s bytes, measured');
  const file = { path: 'scan', part: { type: 'image' as const, source: { path: '/claims/scan.png' } } };
  await refused(readPicture(file), 'DECISION_INVALID', /`scan`.*\/claims\/scan\.png.*no readFile/);
  const fromFile = await readPicture(file, { readFile: async () => scenePng(RED) });
  assert.equal(fromFile.width, 640, 'a file read with readFile');
  const pdf = {
    path: 'doc',
    part: { type: 'image' as const, source: { base64: base64(new TextEncoder().encode('%PDF-1.7')) } },
  };
  await refused(readPicture(pdf), 'DECISION_INVALID', /`doc` is not an image its bytes name, but application\/pdf/);
});

test('a box is answered with four edges and a confidence, checked alike from any provider, and judged by overlap', () => {
  const box = { top: 0.1, bottom: 0.5, left: 0.2, right: 0.6 };
  const answer = decisionAnswer(where, { type: 'box', box, confidence: 0.8 });
  assert.deepEqual(answer, { type: 'box', box, confidence: 0.8 });
  const bad: Array<[Record<string, number>, number, RegExp]> = [
    [{ ...box, top: -0.1 }, 0.5, /top edge is -0\.1/],
    [{ ...box, bottom: 1.2 }, 0.5, /bottom edge is 1\.2/],
    [{ ...box, left: Number.NaN }, 0.5, /left edge is NaN/],
    [{ top: 0.1, bottom: 0.5, left: 0.2 }, 0.5, /right edge is undefined/],
    [{ ...box, top: 0.6 }, 0.5, /edges cross/],
    [{ ...box, left: 0.7 }, 0.5, /edges cross/],
    [box, 1.5, /confidence is 1\.5/],
    [box, -0.1, /confidence is -0\.1/],
  ];
  for (const [edges, confidence, why] of bad) {
    assert.throws(
      () => decisionAnswer(where, { type: 'box', box: edges as never, confidence }),
      (error: unknown) =>
        error instanceof DecisionError && error.code === 'DECISION_INVALID' && why.test(error.message),
      `refused: ${why}`,
    );
  }
  assert.throws(() => decisionAnswer(where, { type: 'yes-no', yes: 0.5 }), /box question was answered as a yes-no/);

  const square = { top: 0, bottom: 0.5, left: 0, right: 0.5 };
  close(boxOverlap(square, square), 1, 'a box overlaps itself wholly');
  close(boxOverlap(square, { top: 0.25, bottom: 0.75, left: 0.25, right: 0.75 }), 1 / 7, 'a quarter shared');
  close(boxOverlap(square, { top: 0.5, bottom: 1, left: 0.5, right: 1 }), 0, 'touching at a corner');
  const point = { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 };
  close(boxOverlap(point, point), 1, 'one point is itself');
  close(boxOverlap(point, { ...point, left: 0.4, right: 0.4 }), 0, 'another point is not');

  assert.equal(answeredRight(answer, box), true, 'right where it is');
  const shifted = { top: 0.3, bottom: 0.7, left: 0.4, right: 0.8 };
  assert.equal(answeredRight(answer, shifted), false, 'a seventh of an overlap is not half');
  assert.equal(answeredRight(answer, shifted, { overlap: 0.1 }), true, 'but is a tenth');
  assert.equal(answeredRight(answer, true), false, 'a box is not right by a yes');
  assert.equal(answerProbability(answer), 0.8, 'a box’s confidence stands for its probability');

  const samples = [
    ...Array.from({ length: 10 }, () => ({ answer: { ...answer, confidence: 0.9 }, correct: true })),
    ...Array.from({ length: 10 }, () => ({ answer: { ...answer, confidence: 0.3 }, correct: false })),
  ];
  const report = calibrate(samples, { targetAccuracy: 0.9 });
  assert.equal(report.threshold, 0.9, 'boxes are calibrated by their confidence as any answer is');
  assert.equal(report.coverage, 0.5);
});

test('a decision about a picture is refused where it cannot be asked: a whole-state picture, a box without a picture or a question, a provider that reads none', async () => {
  const mock = new MockDecisionProvider();
  const manager = new DecisionManager({ providers: { mock } });
  const red = picture(RED);
  await refused(
    manager.decide({ state: red as never, questions: { marked } }),
    'DECISION_INVALID',
    /whole state.*\{ photo: picture \}/,
  );
  await refused(
    manager.decide({ state: { note: 'No picture here' }, questions: { where } }),
    'DECISION_INVALID',
    /Box "where" asks where something is in a picture, and the state holds none/,
  );
  await refused(manager.decide({ state: 'A text', questions: { where } }), 'DECISION_INVALID', /holds none/);
  await refused(
    manager.decide({ state: { photo: red }, questions: { where: { type: 'box', question: '  ' } } }),
    'DECISION_INVALID',
    /Box "where" needs a question/,
  );
  assert.equal(mock.requests.length, 0, 'none reached the provider');

  const text: DecisionProvider = {
    info: { name: 'text', capabilities: { types: ['yes-no'], maxOptions: 2, maxLevels: 2, defaultModel: 'text-1' } },
    decide: async () => ({ distributions: { marked: { type: 'yes-no', yes: 0.7 } } }),
  };
  const down = new MockDecisionProvider({
    name: 'down',
    fail: new DecisionError('overloaded', 'DECISION_FAILED', true, 503),
  });
  const both = new DecisionManager({ providers: { text, down, mock }, fallbacks: ['text', 'mock'] });
  await refused(
    both.decide({ state: { photo: red }, questions: { marked }, provider: 'text' }),
    'DECISION_UNSUPPORTED',
    /"text" does not read pictures, and the state holds 1, such as `photo`/,
  );
  const failedOver = await both.decide({ state: { photo: red }, questions: { marked }, provider: 'down' });
  assert.equal(failedOver.provider, 'mock', 'a fallback that reads no pictures is passed over for one that does');
  const plain = await both.decide({ state: { note: 'The door is fine' }, questions: { marked }, provider: 'text' });
  assert.equal(plain.provider, 'text', 'and still answers about text');

  // A provider that answers boxes must read pictures to find them in; the mock answers the whole picture.
  const incoherent: DecisionProvider = {
    info: { name: 'boxes', capabilities: { types: ['box'], maxOptions: 2, maxLevels: 2, defaultModel: 'b-1' } },
    decide: async () => ({ distributions: {} }),
  };
  const report = await runDecisionConformance(incoherent, { picture: red });
  assert.ok(
    report.failures.includes('capabilities: it answers boxes, and reads no pictures to find them in'),
    report.failures.join('; '),
  );
  const even = await decide(new MockDecisionProvider(), { state: { photo: red }, questions: { where } });
  assert.deepEqual(even.answers.where, { type: 'box', box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0 });
});

test('a picture is keyed and traced by a digest, never its bytes, and held against the budget as a picture', async () => {
  const store = new MemoryCacheAdapter<CachedDecision>();
  const traces = new MemoryTraceStore();
  const mock = new MockDecisionProvider({ answer: () => ({ type: 'yes-no', yes: 0.9 }) });
  const manager = new DecisionManager(
    { providers: { mock }, cache: { store } },
    { tracer: new Tracer({ store: traces }) },
  );
  const ask = (photo: ImageContent) => manager.decide({ state: { claim: 'Claim 7', photo }, questions: { marked } });
  const red = picture(RED);
  await ask(red);
  assert.equal((await ask(picture(RED))).cached, true, 'the same picture, given again, is the same decision');
  await ask(picture(BLUE));
  assert.equal(mock.requests.length, 2, 'another picture is asked again');
  assert.equal(
    (mock.requests[0]?.state as { photo?: unknown } | undefined)?.photo,
    red,
    'the provider is given the picture itself',
  );
  const run = traces.query({}).find((item) => item.kind === 'decision');
  const traced = JSON.stringify(run?.inputs);
  const bytes = (red.source as { base64: string }).base64;
  assert.ok(!traced.includes(bytes.slice(0, 64)), 'no bytes in the trace');
  assert.match(traced, /"photo":\{"picture":"sha256:[0-9a-f]{64}"\}/, 'the picture by its digest');
  assert.match(traced, /"claim":"Claim 7"/, 'and the rest of the state as it was');

  // A picture's base64 is not read as text: a noisy picture is some 90,000 tokens of it.
  const noisy = picture({ width: 300, height: 300, noise: true });
  assert.ok((noisy.source as { base64: string }).base64.length > 350_000, 'a picture that hardly compresses');
  const api = typesafeStandIn({ judge: typesafeJudge });
  const budgeted = (limit: number) =>
    new DecisionManager(
      { providers: { typesafe: new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }) } },
      { lifecycle: new NexusAI({ providers: {}, lifecycle: { budget: budgetLedger({ limit }) } }).lifecycle },
    );
  // A picture is held at 1,600 tokens, $0.0000672 at Jev's price: a budget below it cannot hold one.
  await assert.rejects(budgeted(0.00006).decide({ state: { photo: noisy }, questions: { marked } }), /[Bb]udget/);
  assert.equal(api.seen.length, 0, 'refused before it was sent');
  const held = await budgeted(0.0002).decide({ state: { photo: noisy }, questions: { marked } });
  assert.equal(held.answers.marked.type, 'yes-no', 'and a budget well above it holds the picture, bytes and all');
});

test('TypeSafe AI: the pictures go as assets by new references, behind the images header, and a box comes back', async () => {
  const api = typesafeStandIn({ judge: typesafeJudge });
  const manager = new DecisionManager({
    providers: { typesafe: new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }) },
  });
  const red = picture(RED);
  const state = {
    claim: 'Claim 7: a mark on the door',
    photo: red,
    earlier: [{ photo: { type: 'image', source: { buffer: scenePng(BLUE) } } }],
  };
  const questions = {
    marked,
    earlier: {
      type: 'choice',
      question: 'What colour is the mark in `earlier[0].photo`?',
      options: ['red', 'green', 'blue'],
    },
    where,
  } as const;
  const result = await manager.decide({ state, questions });
  const sent = api.seen[0];
  assert.equal(sent?.headers.get('TypeSafe-Danger-Zone-Images'), 'true', 'the images header');
  const wire = sent?.body?.state as { claim: string; photo: string; earlier: Array<{ photo: string }> };
  const references = Object.keys(sent?.body?.assets ?? {});
  assert.deepEqual(
    references.sort(),
    [wire.photo, wire.earlier[0]?.photo].sort(),
    'each picture by a reference, in its place',
  );
  assert.match(
    wire.photo,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'a UUID, as the API advises',
  );
  assert.equal(wire.claim, 'Claim 7: a mark on the door', 'the rest of the state as it was');
  assert.deepEqual(sent?.body?.assets?.[wire.photo], {
    type: 'image',
    format: 'png',
    data_base64: (red.source as { base64: string }).base64,
  });
  assert.deepEqual(sent?.body?.questions?.where, { type: 'box', instructions: 'the mark in `photo`' });
  assert.equal(result.answers.marked.yes, true);
  assert.equal(result.answers.earlier.choice, 'blue', 'a picture deeper in the state, read by its path');
  assert.deepEqual(result.answers.where, { type: 'box', box: boxOf(RED), confidence: 0.9 });
  assert.equal(result.model, 'jev-1.14.0', 'jev-latest serves boxes');

  await manager.decide({ state, questions: { marked } });
  const again = api.seen[1]?.body?.state as { photo: string };
  assert.notEqual(again.photo, wire.photo, 'a new reference in each request');
  await manager.decide({ state: 'The door is fine.', questions: { marked } });
  assert.equal(api.seen[2]?.headers.get('TypeSafe-Danger-Zone-Images'), null, 'text alone sends no images header');
  assert.equal(api.seen[2]?.body?.assets, undefined, 'and no assets');
});

test('TypeSafe AI: a picture it would refuse is refused first, by its path, and a box is not asked of Jev 1.13', async () => {
  const api = typesafeStandIn({ judge: typesafeJudge });
  const provider = new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch });
  const manager = new DecisionManager({ providers: { typesafe: provider } });
  const ask = (state: Record<string, unknown>, questions: DecisionQuestions = { marked }, model?: string) =>
    manager.decide({ state, questions, ...(model ? { model } : {}) });
  const gif = new Uint8Array(64);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0x2c, 0x01]);
  const large = new Uint8Array(16 * 1024 * 1024 + 1);
  large.set(scenePng(RED));
  const pictures: Array<[unknown, RegExp]> = [
    [picture({ width: 200, height: 400 }), /`photo` is 200 by 400 pixels, and TypeSafe AI takes 280 to 1568 a side/],
    [picture({ width: 1600, height: 900 }), /`photo` is 1600 by 900 pixels/],
    [picture({ width: 400, height: 279 }), /400 by 279/],
    [{ type: 'image', source: { buffer: gif } }, /`photo` is image\/gif, and TypeSafe AI takes PNG and JPEG/],
    [{ type: 'image', source: { base64: base64(animatedPng(RED)) } }, /`photo` is an animated PNG/],
    [{ type: 'image', source: { buffer: large } }, /`photo` is 16777217 bytes, over TypeSafe AI's 16777216/],
  ];
  for (const [photo, why] of pictures) await refused(ask({ photo }), 'DECISION_INVALID', why);
  // Three pictures of ten megabytes each are 40 MB as base64: over the request's 32 MiB.
  const heavy = new Uint8Array(10 * 1024 * 1024);
  heavy.set(scenePng(RED));
  const three = Object.fromEntries(['a', 'b', 'c'].map((key) => [key, { type: 'image', source: { buffer: heavy } }]));
  await refused(
    ask(three, { marked: { type: 'yes-no', question: 'Is `a` like `b` and `c`?' } }),
    'DECISION_INVALID',
    /takes at most 33554432/,
  );
  await refused(
    ask({ photo: picture(RED) }, { where }, 'jev-1.13.0'),
    'DECISION_UNSUPPORTED',
    /Jev 1\.14 or later, not jev-1\.13\.0/,
  );
  assert.equal(api.seen.length, 0, 'none of them was sent');
  await ask({ photo: picture({ width: 280, height: 1568 }) });
  await ask({ photo: picture(RED) }, { where }, 'jev-1.14.0');
  assert.equal(api.seen.length, 2, 'a picture at the limits, and a box of Jev 1.14, are asked');

  // What the API refuses anyway is a refused decision, not a failure to try again.
  for (const status of [400, 413]) {
    const refusing = new TypeSafeDecisionProvider({
      apiKey: 'ts-key',
      fetch: async () => new Response(JSON.stringify({ detail: 'Asset x: nothing references it' }), { status }),
    });
    await assert.rejects(
      decide(refusing, { state: { photo: picture(RED) }, questions: { marked } }),
      (error: unknown) =>
        error instanceof DecisionError &&
        error.code === 'DECISION_INVALID' &&
        error.status === status &&
        !error.retryable &&
        /refused the decision: Asset x: nothing references it/.test(error.message),
    );
  }
  // The stand-in holds the API to its documentation: pictures without the header are refused.
  const body = JSON.stringify({
    model: 'jev-latest',
    state: { photo: 'ref-1' },
    questions: { q: { type: 'noul', instructions: 'Is there a mark in `photo`?' } },
    assets: { 'ref-1': { type: 'image', format: 'png', data_base64: base64(scenePng(RED)) } },
  });
  const plain = { authorization: 'Bearer ts-key', 'content-type': 'application/json' };
  const url = 'https://api.typesafe.ai/v1/systemone';
  assert.equal((await api.fetch(url, { method: 'POST', headers: plain, body })).status, 400, 'no header');
  const images = { ...plain, 'TypeSafe-Danger-Zone-Images': 'true' };
  assert.equal((await api.fetch(url, { method: 'POST', headers: images, body })).status, 200, 'with it');
  const unused = body
    .replace('Is there a mark in `photo`?', 'Is it marked?')
    .replace('"photo":"ref-1"', '"photo":"none"');
  assert.equal(
    (await api.fetch(url, { method: 'POST', headers: images, body: unused })).status,
    400,
    'an asset nothing references',
  );
});

test('TypeSafe AI: a picture by path, URL, or stored asset is read with the media readers, and refused by name without them', async () => {
  const files: Record<string, Uint8Array> = { '/claims/7.png': scenePng(RED) };
  const fetched: string[] = [];
  const media = {
    readFile: async (path: string) => {
      const found = files[path];
      if (!found) throw new Error(`no file ${path}`);
      return found;
    },
    fetch: (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response(scenePng(BLUE));
    }) as typeof fetch,
  };
  const state = {
    photo: { type: 'image', source: { path: '/claims/7.png' } },
    before: { type: 'image', source: { url: 'https://cdn.example/claims/7-before.png' } },
  };
  const questions = {
    today: colour,
    earlier: { type: 'choice', question: 'What colour is the mark in `before`?', options: ['red', 'green', 'blue'] },
  } as const;
  const api = typesafeStandIn({ judge: typesafeJudge });
  const reading = new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch, media });
  const { answers } = await decide(reading, { state, questions });
  assert.deepEqual([answers.today.choice, answers.earlier.choice], ['red', 'blue'], 'a file and a URL, each read');
  assert.deepEqual(fetched, ['https://cdn.example/claims/7-before.png']);
  const blind = new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch });
  await refused(
    decide(blind, { state, questions }),
    'DECISION_INVALID',
    /`photo` could not be read: it is the file \/claims\/7\.png, and no readFile/,
  );
  await refused(
    decide(blind, { state: { before: state.before }, questions: { earlier: questions.earlier } }),
    'DECISION_INVALID',
    /`before` could not be read: it is at https:\/\/cdn\.example\/claims\/7-before\.png, and no fetch/,
  );
  await refused(
    decide(reading, {
      state: { photo: { type: 'image', source: { path: '/claims/8.png' } } },
      questions: { today: colour },
    }),
    'DECISION_INVALID',
    /`photo` could not be read: no file \/claims\/8\.png/,
  );
  assert.equal(api.seen.length, 1, 'only the decision whose pictures were read was sent');
});

test('a vision model is shown each picture by its path, and a box is the median of its samples, as sure as they agree', async () => {
  const model = visionModel();
  const manager = new DecisionManager({
    providers: { vision: completionDecisions(model, { model: 'vision-1', samples: 5 }) },
  });
  const red = picture(RED);
  const { answers } = await manager.decide({ state: { claim: 'Claim 7', photo: red }, questions: { colour, where } });
  const asked = model.requests[0];
  const parts = asked?.messages[1]?.content as ContentPart[];
  assert.equal(parts.length, 4, 'the state, the label, the picture, and the question');
  assert.match(
    (parts[0] as { text: string }).text,
    /^State:\n\{\n {2}"claim": "Claim 7",\n {2}"photo": "\[picture `photo`\]"\n\}\n\nThe pictures it holds, by path:$/,
  );
  assert.deepEqual(parts[1], { type: 'text', text: '`photo`:' });
  assert.equal(parts[2], red, 'the picture itself');
  assert.match(
    (parts[3] as { text: string }).text,
    /^Question: What colour is the mark in `photo`\?\nA: red\nB: green\nC: blue\n\nAnswer with one code: A, B, C\.$/,
  );
  assert.equal(answers.colour.choice, 'red');

  const boxes = model.requests.filter((request) =>
    JSON.stringify(request.messages[1]?.content).includes('Answer with four numbers'),
  );
  assert.equal(boxes.length, 5, 'a box from five samples');
  assert.ok(
    boxes.every((request) => request.temperature === 1 && request.logprobs === undefined),
    'sampled, at temperature 1',
  );
  const expected = boxOf(RED);
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    close(answers.where.box[edge], expected[edge], `the median ${edge} edge`, 1e-4);
  }
  assert.ok(
    answers.where.confidence > 0.9 && answers.where.confidence < 1,
    `samples that nearly agree: ${answers.where.confidence}`,
  );

  // Samples that give no box agree with nothing: half of them halve the confidence.
  let call = 0;
  const halting = completionDecisions(
    {
      complete: async () => ({
        content: call++ % 2 ? 'I cannot tell' : '0.2 0.4 0.3 0.5',
        role: 'assistant',
        finishReason: 'stop',
        meta: {} as NexusResponse['meta'],
      }),
    },
    { model: 'halting', samples: 4 },
  );
  const half = await decide(halting, { state: { photo: red }, questions: { where } });
  assert.deepEqual(half.answers.where, {
    type: 'box',
    box: { top: 0.2, bottom: 0.4, left: 0.3, right: 0.5 },
    confidence: 0.5,
  });
  // Samples that disagree: the middle one of an odd count, and the mean of the middle two of an even one.
  const spread = (answers: string[]) => {
    let next = 0;
    return completionDecisions(
      {
        complete: async () => ({
          content: answers[next++ % answers.length] as string,
          role: 'assistant',
          finishReason: 'stop',
          meta: {} as NexusResponse['meta'],
        }),
      },
      { model: 'spread', samples: answers.length },
    );
  };
  const odd = await decide(spread(['0.1 0.5 0.1 0.5', '0.2 0.6 0.2 0.6', '0.4 0.8 0.4 0.8']), {
    state: { photo: red },
    questions: { where },
  });
  assert.deepEqual(odd.answers.where.box, { top: 0.2, bottom: 0.6, left: 0.2, right: 0.6 }, 'the middle sample');
  // Each sample's overlap with it: 0.09 of 0.23, all of it, and 0.04 of 0.28.
  close(odd.answers.where.confidence, (0.09 / 0.23 + 1 + 0.04 / 0.28) / 3, 'as sure as the samples agree');
  const even = await decide(spread(['0.1 0.5 0.1 0.5', '0.2 0.6 0.2 0.6', '0.4 0.8 0.4 0.8', '0.5 0.9 0.5 0.9']), {
    state: { photo: red },
    questions: { where },
  });
  for (const edge of ['top', 'left'] as const) close(even.answers.where.box[edge], 0.3, `the even ${edge} edge`);
  for (const edge of ['bottom', 'right'] as const) close(even.answers.where.box[edge], 0.7, `the even ${edge} edge`);

  // Edges that cross, and pixels where fractions were asked for, are no box.
  let wrong = 0;
  const lost = completionDecisions(
    {
      complete: async () => ({
        content: wrong++ % 2 ? '120 340 60 200' : '0.6 0.4 0.3 0.5 or 2 3 4 5',
        role: 'assistant',
        finishReason: 'stop',
        meta: {} as NexusResponse['meta'],
      }),
    },
    { model: 'lost', samples: 3 },
  );
  await refused(
    decide(lost, { state: { photo: red }, questions: { where } }),
    'DECISION_FAILED',
    /"lost" answered none of 3 samples with a box/,
  );
  const strict = completionDecisions(visionModel(), { model: 'vision-1', method: 'logprobs' });
  await refused(
    decide(strict, { state: { photo: red }, questions: { where } }),
    'DECISION_UNSUPPORTED',
    /not from log probabilities/,
  );

  // A text-only model takes no box and no picture, and is passed over for one that does.
  const textOnly = completionDecisions(visionModel(), { model: 'text-1', images: false });
  assert.deepEqual(textOnly.info.capabilities.types, ['yes-no', 'choice', 'score']);
  const fallback = new DecisionManager({
    providers: { text: textOnly, vision: completionDecisions(visionModel(), { model: 'vision-1' }) },
    fallbacks: ['vision'],
  });
  await refused(
    fallback.decide({ state: { photo: red }, questions: { marked }, provider: 'text' }),
    'DECISION_UNSUPPORTED',
    /does not read pictures/,
  );
  const plain = visionModel();
  await decide(completionDecisions(plain, { model: 'vision-1' }), {
    state: 'The door is fine.',
    questions: { marked },
  });
  assert.equal(
    typeof plain.requests[0]?.messages[1]?.content,
    'string',
    'a decision about text is asked as text, as before',
  );
});

test('a decision evaluator scores a box by how far it overlaps where the thing is', async () => {
  const found = boxOf(RED);
  const manager = new DecisionManager({
    providers: { mock: new MockDecisionProvider({ answer: () => ({ type: 'box', box: found, confidence: 0.7 }) }) },
  });
  const context = (expected: unknown) =>
    ({
      example: { id: 'claim-7', inputs: {}, expected },
      output: picture(RED),
      latencyMs: 1,
      run: 0,
    }) as EvaluationContext;
  const judged = decisionEvaluator(manager, {
    key: 'mark',
    question: where,
    state: (item) => ({ photo: item.output }),
    where: (item) => item.example.expected as DecisionBox,
  });
  const right = (await judged(context(found))) as EvaluationScore;
  assert.deepEqual([right.score, right.passed], [1, true]);
  assert.deepEqual(right.metadata?.box, found, 'the box in the metadata');
  assert.equal(right.metadata?.confidence, 0.7);
  const wrong = (await judged(context({ top: 0.8, bottom: 0.9, left: 0.8, right: 0.9 }))) as EvaluationScore;
  assert.deepEqual([wrong.score, wrong.passed], [0, false]);
  const loose = decisionEvaluator(manager, {
    key: 'mark',
    question: where,
    state: (item) => ({ photo: item.output }),
    where: () => ({ ...found, right: found.right + 0.1 }),
    overlap: 0.9,
  });
  assert.equal(((await loose(context(undefined))) as EvaluationScore).passed, false, 'a stricter overlap');
  const unknown = (await decisionEvaluator(manager, {
    key: 'mark',
    question: where,
    state: (item) => ({ photo: item.output }),
  })(context(undefined))) as EvaluationScore;
  assert.deepEqual([unknown.score, unknown.passed], [0.7, undefined], 'without where it is, the box’s confidence');
});

test('proof: one decision suite passes on pictures, on TypeSafe AI’s API and on a vision model, with a box landing where the picture has it', async () => {
  const level = {
    type: 'score',
    question: 'How much of `photo` does the mark cover?',
    levels: ['Under a tenth', 'A tenth to a third', 'Over a third'],
  } as const;
  const named = {
    type: 'choice',
    question: 'What colour is the mark in `photo`?',
    options: { red: 'Red', green: 'Green', blue: 'Blue' },
  } as const;
  const cases: DecisionConformanceCase[] = [
    { state: { claim: 'Claim 7', photo: picture(RED) }, question: marked, expected: true },
    { state: { claim: 'Claim 8', photo: picture(BLANK) }, question: marked, expected: false },
    { state: { photo: { type: 'image', source: { buffer: scenePng(BLUE) } } }, question: named, expected: 'blue' },
    {
      state: {
        photo: { type: 'asset', asset: { mimeType: 'image/png', location: { kind: 'bytes', data: scenePng(GREEN) } } },
      },
      question: named,
      expected: 'green',
    },
    { state: { photo: picture(GREEN) }, question: level, expected: 2 },
    { state: { photo: picture(RED) }, question: level, expected: 0 },
    { state: { photo: picture(RED) }, question: where, expected: boxOf(RED) },
    {
      state: { frames: [{ frame: picture(BLANK) }, { frame: picture(BLUE) }] },
      question: { type: 'box', question: 'the mark in `frames[1].frame`' },
      expected: boxOf(BLUE),
    },
  ];
  const api = typesafeStandIn({ judge: typesafeJudge });
  const providers: Record<string, DecisionProvider> = {
    'TypeSafe AI': new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }),
    'a vision model': completionDecisions(visionModel(), { model: 'vision-1' }),
  };
  for (const [name, provider] of Object.entries(providers)) {
    const report = await runDecisionConformance(provider, { cases, picture: picture(RED) });
    assert.deepEqual(report.failures, [], `${name} fails nothing`);
    assert.deepEqual(report.skipped, [], `${name} skips nothing`);
    for (const check of ['a box question', 'a question about a picture', 'several questions in one decision']) {
      assert.ok(report.passed.includes(check), `${name} passes ${check}`);
    }
    assert.equal(
      report.passed.filter((check) => check.startsWith('case ')).length,
      cases.length,
      `${name}: every case`,
    );
    for (const item of cases.filter((entry) => entry.question.type === 'box')) {
      const { answers } = await decide(provider, { state: item.state, questions: { where: item.question } });
      const overlap = boxOverlap((answers.where as { box: DecisionBox }).box, item.expected as DecisionBox);
      assert.ok(overlap > 0.95, `${name}: the box lands where the picture has it, overlapping ${overlap}`);
    }
  }

  // The suite tells a reader of pictures from one that reads only the text.
  const blind = await runDecisionConformance(completionDecisions(visionModel({ blind: true }), { model: 'blind-1' }), {
    cases,
  });
  assert.deepEqual(
    blind.failures.map((failure) => failure.split(':')[0]),
    ['case 2', 'case 3', 'case 4', 'case 6', 'case 7', 'case 8'],
    'a model that does not see the pictures fails every case but those its reading of the text gets right by chance',
  );
  assert.deepEqual(blind.skipped, [
    'a box question: no picture was given to ask about',
    'a question about a picture: no picture was given to ask about',
  ]);
});
