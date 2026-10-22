/**
 * The order an agent server lists threads and runs in, and the cursor that pages through it. The
 * regional gateway reads both, so a cursor one region gave pages every region the same way.
 */

/** A page of a list, newest first, and the cursor of the page after it. */
export interface ListPage<T> {
  /** The page's records, newest first. */
  items: T[];
  /** Asks for the page after this one, as `cursor`. Absent on the last page. */
  nextCursor?: string;
}

/** A record as a list places it: by its last write, then its id. */
interface Listed {
  id?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
}

/** Where a record falls in a list. */
interface Place {
  at: string;
  id: string;
}

const placeOf = (record: Listed): Place => ({
  at: String(record.updatedAt ?? record.createdAt ?? ''),
  id: String(record.id ?? ''),
});

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every list's order: the newest written first, and by id among records written at the same time. */
export function newestFirst(a: Listed, b: Listed): number {
  const x = placeOf(a);
  const y = placeOf(b);
  return compare(y.at, x.at) || compare(x.id, y.id);
}

/** The cursor of the page after one that ends with `record`. */
export function cursorAfter(record: Listed): string {
  const { at, id } = placeOf(record);
  const bytes = new TextEncoder().encode(JSON.stringify([at, id]));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The place a cursor names, or `undefined` for one no list gave. */
export function readCursor(cursor: string): Place | undefined {
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === 'string')) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // Not one a list gave.
  }
  return undefined;
}

/** Whether `record` comes after `place`, so belongs to the pages after the cursor that names it. */
export function isAfter(record: Listed, place: Place): boolean {
  const own = placeOf(record);
  return own.at < place.at || (own.at === place.at && own.id > place.id);
}

/**
 * The page of the records `keep` takes, after `after`, from a store that lists newest written first.
 * It reads more of the store until the page is full or the store ends. Until the store ends, only
 * records newer than the oldest one read are placed for sure: another written in that same instant
 * may be unread yet, and come before them by id.
 */
export async function pageOf<R extends Listed>(
  list: (limit: number) => Promise<R[]> | R[],
  keep: (record: R) => boolean,
  limit: number,
  after: Place | undefined,
): Promise<ListPage<R>> {
  // A page, the record that says another follows, and the oldest read, whose place is not yet sure.
  for (let window = limit + 2; ; window *= 4) {
    const read = await list(window);
    const ended = read.length < window;
    const times = read.map((record) => placeOf(record).at);
    const oldest = times.reduce((min, at) => (at < min ? at : min), times[0] ?? '');
    const placed = read
      .filter((record) => keep(record) && (!after || isAfter(record, after)) && (ended || placeOf(record).at > oldest))
      .sort(newestFirst);
    if (placed.length > limit || ended) {
      const items = placed.slice(0, limit);
      return placed.length > limit ? { items, nextCursor: cursorAfter(items[limit - 1] as R) } : { items };
    }
  }
}
