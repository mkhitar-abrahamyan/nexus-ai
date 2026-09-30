import assert from 'node:assert/strict';
import type { OperationRecord, OperationStore } from '../src/types/operations.js';

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
const LONG_AGO = '2000-01-01T00:00:00.000Z';

function at(minute: number): string {
  return `2026-09-21T00:${String(minute).padStart(2, '0')}:00.000Z`;
}

function record(overrides: Partial<OperationRecord<string>>): OperationRecord<string> {
  return {
    id: 'op',
    status: 'queued',
    attempt: 1,
    maxAttempts: 1,
    sequence: 0,
    createdAt: at(30),
    updatedAt: at(30),
    ...overrides,
  };
}

/**
 * What every store's `listQueued()` and `stats()` must agree on: oldest first, held records skipped,
 * kinds filtered by prefix, finished records left uncounted, and lapsed leases reported.
 */
export async function queueContract(name: string, store: OperationStore<string>): Promise<void> {
  await store.create(record({ id: 'q-late', kind: 'assistant:a', createdAt: at(3) }));
  await store.create(record({ id: 'q-early', kind: 'assistant:b', createdAt: at(1) }));
  await store.create(record({ id: 'q-other', kind: 'image.generate', createdAt: at(2) }));
  await store.create(
    record({ id: 'q-held', kind: 'assistant:a', createdAt: at(0), lease: { owner: 'w', expiresAt: FAR_FUTURE } }),
  );
  await store.create(
    record({ id: 'r-live', status: 'running', kind: 'assistant:a', lease: { owner: 'w', expiresAt: FAR_FUTURE } }),
  );
  await store.create(
    record({ id: 'r-lapsed', status: 'running', kind: 'assistant:a', lease: { owner: 'w', expiresAt: LONG_AGO } }),
  );
  await store.create(record({ id: 'done', status: 'succeeded', kind: 'assistant:a' }));

  const ids = (records: ReadonlyArray<OperationRecord<string>>) => records.map((item) => item.id);
  assert.deepEqual(ids((await store.listQueued?.(10)) ?? []), ['q-early', 'q-other', 'q-late'], name);
  assert.deepEqual(
    ids((await store.listQueued?.(10, { kindPrefix: 'assistant:' })) ?? []),
    ['q-early', 'q-late'],
    `${name}: kind prefix`,
  );
  assert.deepEqual(ids((await store.listQueued?.(1)) ?? []), ['q-early'], `${name}: limit`);

  const now = '2026-09-21T01:00:00.000Z';
  assert.deepEqual(
    await store.stats?.(now),
    { byStatus: { queued: 4, running: 2 }, oldestQueuedAt: at(0), lapsedLeases: 1 },
    `${name}: stats`,
  );
  assert.deepEqual(
    await store.stats?.(now, { kindPrefix: 'image.' }),
    { byStatus: { queued: 1 }, oldestQueuedAt: at(2), lapsedLeases: 0 },
    `${name}: stats by kind`,
  );
}
