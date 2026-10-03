import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { appendList, counter } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer, OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import { createGraph } from '../src/graph/graph.js';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresOperationStore } from '../src/postgres/operations.js';
import { SqliteOperationStore } from '../src/sqlite/operations.js';
import { type DurabilityMode, END, type GraphCheckpointer, Send } from '../src/types/graph.js';

/**
 * Kills a run at every durable boundary and checks that a fresh process, on the same store, brings
 * the thread to exactly the state an uninterrupted run reaches.
 *
 * A "crash" stops every write from that moment, as a process that exits would: the store keeps what
 * was written before it and nothing after. Side effects may repeat — the guarantee is at least once —
 * but the state a thread ends in may not change.
 */

class Crash extends Error {
  constructor() {
    super('the process died');
    this.name = 'Crash';
  }
}

/** Where a crash lands. */
type Boundary =
  | { kind: 'before-write'; at: number }
  | { kind: 'during-write'; at: number }
  | { kind: 'after-write'; at: number }
  | { kind: 'during-node'; node: string }
  | { kind: 'after-side-effect'; node: string };

/** One process: a checkpointer that dies on cue, and the switch nodes use to die mid-task. */
function processOn(store: GraphCheckpointer, boundary?: Boundary) {
  let dead = false;
  let writes = 0;
  const die = (): never => {
    dead = true;
    throw new Crash();
  };
  const checkpointer: GraphCheckpointer = {
    async put(checkpoint) {
      if (dead) throw new Crash();
      writes += 1;
      if (boundary?.kind === 'before-write' && boundary.at === writes) die();
      await store.put(checkpoint);
      if (boundary?.kind === 'during-write' && boundary.at === writes) die();
      if (boundary?.kind === 'after-write' && boundary.at === writes) dead = true;
    },
    get: (threadId, step) => store.get(threadId, step),
    history: (threadId, limit) => store.history(threadId, limit),
  };
  /** Dies in `node`, before its side effect or after it, when that is where this process crashes. */
  const crashIn = (node: string, phase: 'before' | 'after') => {
    if (!boundary || !('node' in boundary) || boundary.node !== node) return;
    if ((boundary.kind === 'during-node') === (phase === 'before')) die();
  };
  return { checkpointer, crashIn, writes: () => writes };
}

/**
 * A graph with every scheduling feature a crash can land in: a static fan-out, a dynamic `Send`
 * fan-out, a task that needs a retry, a deferred join, and a loop a router ends.
 */
function workflow(life: ReturnType<typeof processOn>, effects: { count: number }, durability: DurabilityMode) {
  return createGraph({ channels: { log: appendList<string>(), rounds: counter() } })
    .addNode('plan', () => {
      life.crashIn('plan', 'before');
      life.crashIn('plan', 'after');
      return { log: ['plan'] };
    })
    .addNode(
      'fetch',
      ({ input, attempt }) => {
        const item = input as number;
        if (item === 2 && attempt === 1) throw new Error('flaky source');
        if (item === 1) life.crashIn('fetch', 'before');
        effects.count += 1;
        if (item === 1) life.crashIn('fetch', 'after');
        return { log: [`fetch:${item}`] };
      },
      { retry: { maxAttempts: 2, initialIntervalMs: 1, jitter: false }, ends: ['join'] },
    )
    .addNode('audit', () => ({ log: ['audit'] }))
    .addNode(
      'join',
      ({ state }) => {
        life.crashIn('join', 'before');
        life.crashIn('join', 'after');
        return { log: [`join:${state.log.filter((entry) => entry.startsWith('fetch')).length}`] };
      },
      { defer: true },
    )
    .addNode('refine', () => {
      life.crashIn('refine', 'before');
      effects.count += 1;
      life.crashIn('refine', 'after');
      return { rounds: 1, log: ['refine'] };
    })
    .setEntry('plan')
    .addConditionalEdges('plan', () => ['audit', ...[0, 1, 2].map((item) => new Send('fetch', item))])
    .addEdge('fetch', 'join')
    .addEdge('audit', 'join')
    .addEdge('join', 'refine')
    .addConditionalEdges('refine', (state) => (state.rounds < 2 ? 'refine' : END), { refine: 'refine', [END]: END })
    .compile({ checkpointer: life.checkpointer, durability });
}

/** Runs a thread to its end in a fresh process, from wherever the store left it. */
async function recover(store: GraphCheckpointer, threadId: string, durability: DurabilityMode) {
  const life = processOn(store);
  const graph = workflow(life, { count: 0 }, durability);
  if (!(await store.get(threadId))) return graph.invoke({}, { threadId });
  for await (const _ of graph.continue(threadId)) {
    // Runs on from the last checkpoint written before the crash.
  }
  const final = await graph.state(threadId);
  assert.equal(final?.status, 'completed', `${threadId} completes after the restart`);
  return { state: final?.state };
}

let pg: PGlite;
let tables = 0;
before(async () => {
  pg = new PGlite();
  await pg.waitReady;
});
after(async () => {
  await pg.close();
});

/** Every checkpointer a graph can persist through, each with a fresh store. */
const backends: Array<[string, () => Promise<GraphCheckpointer>]> = [
  ['memory', async () => new MemoryGraphCheckpointer()],
  ['operation store', async () => new OperationStoreCheckpointer(new MemoryOperationStore())],
  [
    'SQLite',
    async () => {
      const store = new SqliteOperationStore(new DatabaseSync(':memory:'));
      await store.migrate();
      return new OperationStoreCheckpointer(store as never);
    },
  ],
  [
    'Postgres',
    async () => {
      const store = new PostgresOperationStore(pg as unknown as PostgresLikeClient, { table: `crash_${++tables}` });
      await store.migrate();
      return new OperationStoreCheckpointer(store as never);
    },
  ],
  [
    'Redis',
    async () => {
      const hashes = new Map<string, Map<string, string>>();
      const hash = (key: string) => {
        let entry = hashes.get(key);
        if (!entry) {
          entry = new Map();
          hashes.set(key, entry);
        }
        return entry;
      };
      const client = {
        hget: (key: string, field: string) => hash(key).get(field) ?? null,
        hset: (key: string, field: string, value: string) => void hash(key).set(field, value),
        hdel: (key: string, field: string) => void hash(key).delete(field),
        hvals: (key: string) => [...hash(key).values()],
      };
      return new OperationStoreCheckpointer(new RedisOperationStore(client) as never);
    },
  ],
];

for (const [name, open] of backends) {
  test(`${name}: a crash at any durable boundary resumes to the state an uninterrupted run reaches`, async () => {
    const baselineLife = processOn(new MemoryGraphCheckpointer());
    const baseline = await workflow(baselineLife, { count: 0 }, 'sync').invoke({}, { threadId: 'baseline' });
    assert.equal(baseline.status, 'completed');
    const writes = baselineLife.writes();
    assert.ok(writes >= 5, 'the workflow checkpoints several times');

    const boundaries: Boundary[] = [];
    for (let at = 1; at <= writes; at += 1) {
      boundaries.push({ kind: 'before-write', at }, { kind: 'during-write', at }, { kind: 'after-write', at });
    }
    for (const node of ['plan', 'fetch', 'join', 'refine']) {
      boundaries.push({ kind: 'during-node', node }, { kind: 'after-side-effect', node });
    }

    const store = await open();
    let crashes = 0;
    for (const durability of ['sync', 'async'] as const) {
      for (const [index, boundary] of boundaries.entries()) {
        const threadId = `${durability}-${index}`;
        const life = processOn(store, boundary);
        const outcome = await workflow(life, { count: 0 }, durability)
          .invoke({}, { threadId })
          .then(
            () => 'finished',
            (error: unknown) =>
              error instanceof Crash || (error as { cause?: unknown }).cause instanceof Crash ? 'crashed' : error,
          );
        if (outcome !== 'finished' && outcome !== 'crashed') throw outcome;
        if (outcome === 'crashed') crashes += 1;
        const resumed = await recover(store, threadId, durability);
        assert.deepEqual(
          resumed.state,
          baseline.state,
          `${durability} crash ${JSON.stringify(boundary)} resumes to the uninterrupted state`,
        );
      }
    }
    assert.ok(crashes >= boundaries.length, 'the crashes really happened');
  });
}
