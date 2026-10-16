#!/usr/bin/env node
/**
 * Realtime turn latency and session load, held to budgets the way runtime and import sizes are.
 *
 * What the library adds to a call is measured, not the provider: each session runs over an in-memory
 * transport that delivers a provider's messages for a spoken turn (the caller's speech and its
 * transcript, the response, 25 frames of 20 ms audio with its transcript, and the turn's end with
 * usage), each message in a macrotask of its own, as a socket delivers them.
 *
 * - **A long call:** 550 turns in one session. A turn late in it must cost what an early one does,
 *   within twice, so work that grows with the conversation is caught on any machine.
 * - **Added latency:** from a message's arrival to the session's own event for it, at p50 and p99:
 *   what a caller hears on top of the provider. Held absolutely: under 5 ms at p99 for one call, and
 *   under 20 ms, one audio frame, with 250 calls at real time.
 * - **Calls at real time:** 250 sessions, each sent its messages at the pace a call sends them, one
 *   20 ms step after another. The process must keep up: its event-loop delay under 50 ms at p99, and
 *   finishing within 100 ms of the calls' own length. The share of a core they use is reported, and
 *   the calls one core carries with it.
 * - **Throughput:** 1,000 sessions, ten turns each, as fast as the process takes them, as a ratio to
 *   a calibration loop on the same machine, so a budget recorded on a laptop holds on a slower runner.
 *   The heap each live session holds, with its transcripts and raw events, is held to its budget.
 * - **Retention:** 1,000 sessions run and disconnected one after another leave the heap within 8 MB
 *   of where it started, after a collection.
 *
 *   node --expose-gc scripts/bench-realtime.mjs            # check against realtime-budget.json
 *   node --expose-gc scripts/bench-realtime.mjs --update   # record the current measurements
 *   node --expose-gc scripts/bench-realtime.mjs --json     # print every measurement
 *
 * Runs against the built package in `dist/`; run `npm run build` first.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.gc !== 'function') {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const budgetFile = path.join(root, 'realtime-budget.json');
const args = process.argv.slice(2);
const update = args.includes('--update');
const asJson = args.includes('--json');

const { RealtimeSession, TypedEventEmitter } = await import('../dist/realtime/index.js');

const THROUGHPUT_SESSIONS = 1_000;
const THROUGHPUT_TURNS = 10;
const CALLS = 250;
const CALL_TURNS = 3;
const STEP_MS = 20;
const FRAMES = 25;
// 20 ms of 24 kHz, 16-bit mono audio, as the provider sends it: each frame its own string, as each
// is parsed from its own message.
const FRAME = Buffer.alloc(960, 7).toString('base64');
let frames = 0;
const nextFrame = () => {
  frames += 1;
  return `${FRAME.slice(0, -8)}${String(frames % 1e8).padStart(8, 'A')}`;
};

/**
 * One spoken turn as the steps a call delivers it in, 20 ms apart: the caller's speech, the
 * response's start, a frame of audio per step, and the turn's end.
 */
function turnSteps(n) {
  const response = `response_${n}`;
  const item = `assistant_${n}`;
  const steps = [
    [
      { type: 'input_audio_buffer.speech_started', item_id: `user_${n}` },
      { type: 'input_audio_buffer.speech_stopped', item_id: `user_${n}` },
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: `user_${n}`,
        transcript: 'Can you move my booking to Saturday at seven?',
      },
    ],
    [{ type: 'response.created', response: { id: response } }],
  ];
  for (let index = 0; index < FRAMES; index += 1) {
    steps.push([
      { type: 'response.output_audio.delta', response_id: response, item_id: item, delta: nextFrame() },
      ...(index % 5 === 0
        ? [{ type: 'response.output_audio_transcript.delta', response_id: response, item_id: item, delta: 'Done, ' }]
        : []),
    ]);
  }
  steps.push([
    {
      type: 'response.output_audio_transcript.done',
      response_id: response,
      item_id: item,
      transcript: 'Done, your booking is now Saturday at seven.',
    },
    {
      type: 'response.done',
      response: { id: response, status: 'completed', output: [], usage: { input_tokens: 120, output_tokens: 40 } },
    },
  ]);
  return steps;
}

/** A provider's end, in memory. */
class Transport {
  kind = 'websocket';
  state = 'idle';
  emitter = new TypedEventEmitter();
  on(event, listener) {
    return this.emitter.on(event, listener);
  }
  async connect() {
    this.state = 'connected';
    this.emitter.emit('connected', { sessionId: 'provider', transport: this.kind, timestamp: 0 });
  }
  sendAudio() {}
  sendEvent() {}
  interrupt() {}
  async disconnect() {
    this.state = 'disconnected';
    this.emitter.emit('disconnected', { transport: this.kind, timestamp: 0, expected: true, retryable: false });
  }
  /** Delivers one step's messages, noting when a response's start arrived. */
  deliver(step, arrived) {
    for (const event of step) {
      if (event.type === 'response.created') arrived.push(performance.now());
      this.emitter.emit('data', { event, raw: event });
    }
  }
}

/** A connected session, and the added latency of each response it starts. */
async function open() {
  const transport = new Transport();
  const session = new RealtimeSession({ model: 'gpt-realtime', transport, conversation: { captureTranscripts: true } });
  const arrived = [];
  const added = [];
  session.on('assistant.response.created', () => {
    const at = arrived.shift();
    if (at !== undefined) added.push(performance.now() - at);
  });
  await session.connect();
  return { transport, session, arrived, added };
}

const macrotask = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
const heap = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
};

async function calibrate() {
  const runs = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    let sum = 0;
    const items = [];
    for (let index = 0; index < 200_000; index += 1) {
      items.push({ index, text: `item ${index}` });
      if (items.length > 1_000) items.splice(0, 500);
      sum += items[items.length - 1].index;
    }
    if (sum < 0) throw new Error('unreachable');
    runs.push(performance.now() - started);
  }
  return percentile(runs, 50);
}

// One call: each message in its own macrotask, as fast as they come.
async function single() {
  const live = await open();
  const turns = [];
  const started = performance.now();
  for (let n = 0; n < 550; n += 1) {
    const started = performance.now();
    for (const step of turnSteps(n)) {
      await macrotask();
      live.transport.deliver(step, live.arrived);
    }
    await live.session.whenIdle();
    if (n >= 50) turns.push(performance.now() - started);
  }
  const ms = performance.now() - started;
  await live.session.disconnect();
  const added = live.added.slice(50);
  return {
    ms,
    turnP50: percentile(turns, 50),
    // A turn late in a long call costs what an early one does: per-event work that grows with the
    // record would show here first.
    growth: percentile(turns.slice(-50), 50) / Math.max(percentile(turns.slice(0, 50), 50), 1e-6),
    addedP50: percentile(added, 50),
    addedP99: percentile(added, 99),
  };
}

// Calls at real time: every session sent its next step every 20 ms, each in a macrotask of its own.
async function calls() {
  const sessions = [];
  for (let index = 0; index < CALLS; index += 1) sessions.push(await open());
  const plans = sessions.map(() => Array.from({ length: CALL_TURNS }, (_, n) => turnSteps(n)).flat());
  const steps = plans[0].length;
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let step = 0; step < steps; step += 1) {
    const wait = started + step * STEP_MS - performance.now();
    if (wait > 0) await sleep(wait);
    sessions.forEach((live, index) => {
      setImmediate(() => live.transport.deliver(plans[index][step], live.arrived));
    });
  }
  await sleep(STEP_MS);
  await Promise.all(sessions.map((live) => live.session.whenIdle()));
  const wall = performance.now() - started;
  const used = process.cpuUsage(cpu);
  delay.disable();
  const length = steps * STEP_MS;
  const share = (used.user + used.system) / 1_000 / wall;
  for (const live of sessions) {
    if (live.session.getConversation().metrics.turns < CALL_TURNS) throw new Error('a call missed a turn');
  }
  const added = sessions.flatMap((live) => live.added);
  for (const live of sessions) await live.session.disconnect();
  return {
    lengthMs: length,
    behindMs: Math.max(0, wall - length - STEP_MS),
    loopP99: delay.percentile(99) / 1e6,
    addedP50: percentile(added, 50),
    addedP99: percentile(added, 99),
    share,
    callsPerCore: Math.floor(CALLS / Math.max(share, 1e-6)),
  };
}

// Throughput: many sessions, as fast as the process takes them.
async function throughput() {
  const before = heap();
  const sessions = [];
  for (let index = 0; index < THROUGHPUT_SESSIONS; index += 1) sessions.push(await open());
  const started = performance.now();
  for (let n = 0; n < THROUGHPUT_TURNS; n += 1) {
    for (const step of turnSteps(n)) {
      for (const live of sessions) live.transport.deliver(step, []);
      await macrotask();
    }
  }
  await Promise.all(sessions.map((live) => live.session.whenIdle()));
  const ms = performance.now() - started;
  const kbPerSession = (heap() - before) / THROUGHPUT_SESSIONS / 1024;
  for (const live of sessions) await live.session.disconnect();
  return { ms, kbPerSession };
}

// Sessions that end leave nothing behind.
async function retention() {
  const before = heap();
  for (let index = 0; index < THROUGHPUT_SESSIONS; index += 1) {
    const live = await open();
    for (let n = 0; n < 3; n += 1) for (const step of turnSteps(n)) live.transport.deliver(step, []);
    await live.session.whenIdle();
    await live.session.disconnect();
  }
  return (heap() - before) / (1024 * 1024);
}

const calibrationMs = await calibrate();
const one = await single();
const paced = await calls();
const bulk = await throughput();
const retainedMb = await retention();

const ratios = {
  'realtime.one-call-550-turns': Number((one.ms / calibrationMs).toFixed(4)),
  'realtime.1000-sessions-10-turns': Number((bulk.ms / calibrationMs).toFixed(4)),
};
const claims = {
  'added latency p99, one call (ms)': { value: one.addedP99, limit: 5 },
  'turn 500 against turn 50, one call (x)': { value: one.growth, limit: 2 },
  [`added latency p99, ${CALLS} calls at real time (ms)`]: { value: paced.addedP99, limit: STEP_MS },
  [`event-loop delay p99, ${CALLS} calls at real time (ms)`]: { value: paced.loopP99, limit: 50 },
  [`behind real time after ${CALLS} calls (ms)`]: { value: paced.behindMs, limit: 100 },
  'heap retained after 1,000 sessions end (MB)': { value: retainedMb, limit: 8 },
};

if (update) {
  writeFileSync(
    budgetFile,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        note: 'Ratios of each timing to a calibration loop on the same machine, and the heap a live session holds. Regenerate with npm run bench:realtime -- --update.',
        tolerance: 3,
        calibrationMs: Number(calibrationMs.toFixed(3)),
        ratios,
        kbPerSession: Number(bulk.kbPerSession.toFixed(1)),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Recorded realtime budgets in ${path.relative(root, budgetFile)}.`);
}

const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
const failures = [];
for (const [name, ratio] of Object.entries(ratios)) {
  const limit = (budget.ratios[name] ?? 0) * budget.tolerance;
  if (!(ratio <= limit)) {
    failures.push(`${name}: ${ratio.toFixed(3)}× the calibration loop, past its budget of ${limit.toFixed(3)}×`);
  }
}
const memoryLimit = budget.kbPerSession * 1.5;
if (!(bulk.kbPerSession <= memoryLimit)) {
  failures.push(
    `a live session holds ${bulk.kbPerSession.toFixed(1)} KB, past its budget of ${memoryLimit.toFixed(1)} KB`,
  );
}
for (const [name, { value, limit }] of Object.entries(claims)) {
  if (!(value < limit)) failures.push(`${name}: ${value.toFixed(3)}, past ${limit}`);
}

const report = { calibrationMs, single: one, calls: paced, throughput: bulk, retainedMb, ratios, claims, failures };
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  const ms = (value) => `${value.toFixed(3)} ms`;
  console.log(
    [
      `Realtime, one call: a turn takes the session ${ms(one.turnP50)} at p50; it adds ${ms(one.addedP50)} to a message at p50 and ${ms(one.addedP99)} at p99.`,
      `${CALLS} calls at real time: ${ms(paced.addedP99)} added at p99, event-loop delay ${ms(paced.loopP99)} at p99, ${ms(paced.behindMs)} behind; ${(paced.share * 100).toFixed(1)}% of a core, so about ${paced.callsPerCore.toLocaleString('en-US')} calls per core.`,
      `${THROUGHPUT_SESSIONS.toLocaleString('en-US')} sessions x ${THROUGHPUT_TURNS} turns: ${ms(bulk.ms)}, ${bulk.kbPerSession.toFixed(1)} KB per live session; ${retainedMb.toFixed(2)} MB left after 1,000 end.`,
    ].join('\n'),
  );
}
if (failures.length) {
  console.error(`Realtime budgets failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
