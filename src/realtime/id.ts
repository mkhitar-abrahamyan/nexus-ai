export type RealtimeIdFactory = (prefix?: string) => string;

export const createRealtimeId: RealtimeIdFactory = (prefix = 'rt') => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const value = cryptoLike?.randomUUID?.() || `${Date.now().toString(36)}_${randomPart()}_${randomPart()}`;
  return `${prefix}_${value}`;
};

function randomPart(): string {
  return Math.random().toString(36).slice(2, 10);
}
