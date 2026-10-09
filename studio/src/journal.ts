import { randomUUID } from 'node:crypto';
import type { StudioRole } from './auth.js';

/** One action someone took, or tried to take, in the studio. */
export interface StudioAuditEntry {
  /** ISO-8601 time. */
  at: string;
  /** Who: the user's id. */
  user: string;
  /** Their role at the time. */
  role: StudioRole;
  /** What, such as `prompt.promote` or `review.submit`. */
  action: string;
  /** The HTTP method. */
  method: string;
  /** The path, which names the target, such as `/api/prompts/answer/promote`. */
  path: string;
  /** `ok` when it happened, `denied` when their role did not allow it, `failed` when it went wrong. */
  outcome: 'ok' | 'denied' | 'failed';
  /** The HTTP status the studio answered with. */
  status: number;
  /** Why it was denied or failed. */
  message?: string;
}

/** Where the audit log is kept. */
export interface StudioAuditLog {
  /** Records an entry. */
  append(entry: StudioAuditEntry): Promise<void> | void;
  /** Entries, newest first, optionally for one user or action, or since a time. */
  list(query?: {
    user?: string;
    action?: string;
    since?: string;
    limit?: number;
  }): Promise<StudioAuditEntry[]> | StudioAuditEntry[];
}

/** A comment on something in the studio. */
export interface StudioComment {
  /** The comment's id. */
  id: string;
  /**
   * What it is about: `run:<id>`, `review:<queue>:<item>`, `proposal:<id>`, `thread:<graph>:<thread>`,
   * `experiment:<id>`, `prompt:<name>`, or `context:<name>`.
   */
  subject: string;
  /** The text. */
  body: string;
  /** The author's user id. */
  author: string;
  /** The author's display name, when known. */
  authorName?: string;
  /** ISO-8601 time. */
  at: string;
}

/** Where comments are kept. */
export interface StudioCommentStore {
  /** Stores a comment. */
  addComment(comment: StudioComment): Promise<void> | void;
  /** The comments on a subject, oldest first. */
  listComments(subject: string): Promise<StudioComment[]> | StudioComment[];
}

/** Options for a `MemoryStudioJournal`. */
export interface MemoryStudioJournalOptions {
  /** Audit entries kept, newest kept first. Defaults to 10,000. */
  maxEntries?: number;
  /** Comments kept, the oldest dropped first. Defaults to 10,000. */
  maxComments?: number;
}

/** The audit log and comments in process memory. The default, and lost on restart. */
export class MemoryStudioJournal implements StudioAuditLog, StudioCommentStore {
  private readonly entries: StudioAuditEntry[] = [];
  private readonly comments: StudioComment[] = [];
  private readonly maxEntries: number;
  private readonly maxComments: number;

  constructor(options: MemoryStudioJournalOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxComments = options.maxComments ?? 10_000;
  }

  /** Records an audit entry, dropping the oldest beyond `maxEntries`. */
  append(entry: StudioAuditEntry): void {
    this.entries.push({ ...entry });
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  /** Audit entries, newest first. */
  list(query: { user?: string; action?: string; since?: string; limit?: number } = {}): StudioAuditEntry[] {
    return filterAudit([...this.entries].reverse(), query);
  }

  /** Stores a comment, dropping the oldest beyond `maxComments`. */
  addComment(comment: StudioComment): void {
    this.comments.push({ ...comment });
    if (this.comments.length > this.maxComments) this.comments.splice(0, this.comments.length - this.maxComments);
  }

  /** The comments on a subject, oldest first. */
  listComments(subject: string): StudioComment[] {
    return this.comments.filter((comment) => comment.subject === subject).map((comment) => ({ ...comment }));
  }
}

/**
 * The audit log and comments as append-only JSON Lines files in a directory — `audit.jsonl` and
 * `comments.jsonl` — so a shared studio keeps them across restarts and they can be shipped to a log
 * system as they are.
 */
export class FileStudioJournal implements StudioAuditLog, StudioCommentStore {
  constructor(private readonly directory: string) {}

  /** Appends an audit entry. */
  async append(entry: StudioAuditEntry): Promise<void> {
    await this.write('audit.jsonl', entry);
  }

  /** Audit entries, newest first. */
  async list(
    query: { user?: string; action?: string; since?: string; limit?: number } = {},
  ): Promise<StudioAuditEntry[]> {
    return filterAudit((await this.read<StudioAuditEntry>('audit.jsonl')).reverse(), query);
  }

  /** Appends a comment. */
  async addComment(comment: StudioComment): Promise<void> {
    await this.write('comments.jsonl', comment);
  }

  /** The comments on a subject, oldest first. */
  async listComments(subject: string): Promise<StudioComment[]> {
    return (await this.read<StudioComment>('comments.jsonl')).filter((comment) => comment.subject === subject);
  }

  private async write(file: string, value: unknown): Promise<void> {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(this.directory, { recursive: true });
    await appendFile(path.join(this.directory, file), `${JSON.stringify(value)}\n`, 'utf8');
  }

  private async read<T>(file: string): Promise<T[]> {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    let text: string;
    try {
      text = await readFile(path.join(this.directory, file), 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return []; // A line cut short by a crash is skipped, not fatal.
        }
      });
  }
}

/** A comment id. */
export function commentId(): string {
  return `c-${randomUUID()}`;
}

function filterAudit(
  entries: StudioAuditEntry[],
  query: { user?: string; action?: string; since?: string; limit?: number },
): StudioAuditEntry[] {
  return entries
    .filter((entry) => !query.user || entry.user === query.user)
    .filter((entry) => !query.action || entry.action === query.action)
    .filter((entry) => !query.since || entry.at >= query.since)
    .slice(0, query.limit ?? 200);
}
