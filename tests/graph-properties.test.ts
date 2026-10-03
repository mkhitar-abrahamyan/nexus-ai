import assert from 'node:assert/strict';
import test from 'node:test';
import { appendList, counter } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { type CompiledGraph, createGraph } from '../src/graph/graph.js';
import { type ChannelSchema, END, type GraphResult, Send } from '../src/types/graph.js';

/**
 * Generated graphs — branches, loops a router ends, `Send` fan-out, a node that needs a retry, and a
 * node that asks a human — must reach the same state from any checkpoint of their history. That is
 * what makes a crash, a fork, or a rewind safe: the checkpoint is a complete description of the run.
 */

/** A small deterministic generator, so a failing case can be reproduced from its seed. */
function random(seed: number) {
  let value = seed >>> 0;
  const next = () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability: number) => next() < probability,
  };
}

/** Builds one random graph from a seed. */
function generate(seed: number, checkpointer: MemoryGraphCheckpointer) {
  const rng = random(seed);
  const size = rng.int(3, 6);
  const names = Array.from({ length: size }, (_, index) => `n${index}`);
  const forward = new Map<string, string[]>(names.map((name) => [name, []]));
  for (let index = 1; index < size; index += 1) {
    (forward.get(`n${rng.int(0, index - 1)}`) as string[]).push(`n${index}`);
    if (rng.chance(0.3) && index + 1 < size)
      (forward.get(`n${index - 1}`) as string[]).push(`n${rng.int(index, size - 1)}`);
  }
  const loopAt = size > 2 && rng.chance(0.6) ? rng.int(1, size - 1) : -1;
  const loopTo = loopAt > 0 ? rng.int(0, loopAt - 1) : -1;
  const fanOutAt = rng.chance(0.6) ? rng.int(0, size - 1) : -1;
  const fanOut = rng.int(1, 4);
  const retryAt = rng.chance(0.5) ? rng.int(0, size - 1) : -1;
  const askAt = rng.chance(0.5) ? rng.int(0, size - 1) : -1;

  const graph = createGraph({ channels: { log: appendList<string>(), loops: counter() } });
  for (const [index, name] of names.entries()) {
    graph.addNode(
      name,
      ({ attempt, interrupt }) => {
        if (index === retryAt && attempt === 1) throw new Error('transient');
        const answer = index === askAt ? `:${interrupt<string>({ reason: name })}` : '';
        return { log: [`${name}${answer}`], ...(index === loopAt ? { loops: 1 } : {}) };
      },
      index === retryAt ? { retry: { maxAttempts: 2, initialIntervalMs: 1, jitter: false } } : {},
    );
  }
  if (fanOutAt >= 0) {
    graph.addNode('worker', ({ input }) => ({ log: [`worker:${input as number}`] }));
    graph.addEdge('worker', END);
  }
  graph.setEntry('n0');

  for (const [index, name] of names.entries()) {
    const targets = forward.get(name) as string[];
    const sends = index === fanOutAt ? Array.from({ length: fanOut }, (_, item) => new Send('worker', item)) : [];
    if (index === loopAt) {
      graph.addConditionalEdges(name, (state) =>
        state.loops < 2 ? `n${loopTo}` : [...(targets.length ? targets : [END]), ...sends],
      );
    } else if (sends.length > 0) {
      graph.addConditionalEdges(name, () => [...(targets.length ? targets : [END]), ...sends]);
    } else if (targets.length === 0) {
      graph.addEdge(name, END);
    } else {
      for (const target of targets) graph.addEdge(name, target);
    }
  }
  return graph.compile({ checkpointer, maxSteps: 200 });
}

/** Runs a thread to completion, answering every question with a value derived from its node. */
async function drive<S extends ChannelSchema>(
  graph: CompiledGraph<S>,
  first: Promise<GraphResult<S>>,
  threadId: string,
): Promise<GraphResult<S>> {
  let result = await first;
  for (let rounds = 0; result.status === 'awaiting_input'; rounds += 1) {
    assert.ok(rounds < 20, 'a run answers its questions in a bounded number of rounds');
    const answers = Object.fromEntries(
      (result.interrupts ?? []).map((pending) => [pending.id, `answer-${pending.node}`]),
    );
    result = await graph.resumeInterruptsWith(threadId, answers);
  }
  return result;
}

async function finish<S extends ChannelSchema>(graph: CompiledGraph<S>, threadId: string): Promise<GraphResult<S>> {
  let last: GraphResult<S> | undefined;
  for await (const event of graph.continue(threadId)) {
    last = { threadId, status: event.status, state: event.state, steps: event.step, interrupts: event.interrupts };
  }
  return drive(graph, Promise.resolve(last as GraphResult<S>), threadId);
}

test('every generated graph reaches the same state from every checkpoint of its history', async () => {
  let checkpointsReplayed = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const checkpointer = new MemoryGraphCheckpointer({ maxPerThread: 500 });
    const graph = generate(seed, checkpointer);
    const baseline = await drive(graph, graph.invoke({}, { threadId: 'baseline' }), 'baseline');
    assert.equal(baseline.status, 'completed', `seed ${seed} completes`);

    const history = await graph.history('baseline', 500);
    for (const checkpoint of history) {
      const forked = await graph.fork('baseline', {
        step: checkpoint.step,
        threadId: `fork-${seed}-${checkpoint.step}`,
      });
      const replayed = await finish(graph, forked);
      assert.equal(replayed.status, 'completed', `seed ${seed} from step ${checkpoint.step} completes`);
      assert.deepEqual(replayed.state, baseline.state, `seed ${seed}: replay from step ${checkpoint.step}`);
      checkpointsReplayed += 1;
    }
  }
  assert.ok(checkpointsReplayed > 150, `replayed ${checkpointsReplayed} checkpoints`);
});
