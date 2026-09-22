/** Creates unique ids, with an optional prefix. */
export type RealtimeIdFactory = (prefix?: string) => string;

/**
 * Creates `<prefix>_<uuid>` ids, falling back to time and random parts where `crypto.randomUUID` is
 * unavailable.
 */
export const createRealtimeId: RealtimeIdFactory = (prefix = 'rt') => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const value = cryptoLike?.randomUUID?.() || `${Date.now().toString(36)}_${randomPart()}_${randomPart()}`;
  return `${prefix}_${value}`;
};

function randomPart(): string {
  return Math.random().toString(36).slice(2, 10);
}
