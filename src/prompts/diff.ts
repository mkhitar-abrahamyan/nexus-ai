import type { PromptMessage, PromptVersion } from '../types/prompts.js';
import { canonicalJson } from './version.js';

/** One line of a message diff: kept, added, or removed. */
export interface PromptLineChange {
  /** `=` kept, `+` added, `-` removed. */
  op: '=' | '+' | '-';
  /** The line. */
  text: string;
}

/** How one message, by position, changed. */
export interface PromptMessageDiff {
  /** Its position in the prompt. */
  index: number;
  /** What happened to it. */
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  /** Role before and after, as `system` or `system → user`, or the placeholder it is. */
  role: string;
  /** The content, line by line. */
  lines: PromptLineChange[];
}

/** A field of partials, configuration, or defaults that differs. */
export interface PromptFieldChange {
  /** The field's name. */
  key: string;
  /** Its value before, absent when it was added. */
  before?: unknown;
  /** Its value after, absent when it was removed. */
  after?: unknown;
}

/** What changed between two versions of a prompt. */
export interface PromptDiff {
  /** The prompt. */
  name: string;
  /** The version compared from. */
  from: string;
  /** The version compared to. */
  to: string;
  /** False when the two versions are the same content. */
  changed: boolean;
  /** Every message, by position. */
  messages: PromptMessageDiff[];
  /** Partials added, removed, or changed. */
  partials: PromptFieldChange[];
  /** Configuration fields added, removed, or changed. */
  config: PromptFieldChange[];
  /** Defaults added, removed, or changed. */
  defaults: PromptFieldChange[];
}

function textOf(message: PromptMessage | undefined): { role: string; text: string } | undefined {
  if (!message) return undefined;
  if ('placeholder' in message) return { role: `placeholder ${message.placeholder}`, text: '' };
  return { role: message.role, text: message.content };
}

/** Line diff by longest common subsequence. Prompts are short, so the quadratic table is cheap. */
export function diffLines(before: string, after: string): PromptLineChange[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      (table[i] as number[])[j] =
        a[i] === b[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((table[i + 1] as number[])[j] as number, (table[i] as number[])[j + 1] as number);
    }
  }
  const out: PromptLineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: '=', text: a[i] as string });
      i += 1;
      j += 1;
    } else if (((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)) {
      out.push({ op: '-', text: a[i] as string });
      i += 1;
    } else {
      out.push({ op: '+', text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] as string });
  while (j < b.length) out.push({ op: '+', text: b[j++] as string });
  return out;
}

function diffFields(before: Record<string, unknown> = {}, after: Record<string, unknown> = {}): PromptFieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))
    .map((key) => ({
      key,
      ...(before[key] === undefined ? {} : { before: before[key] }),
      ...(after[key] === undefined ? {} : { after: after[key] }),
    }));
}

/** Compares two versions of a prompt. */
export function diffPrompts(from: PromptVersion, to: PromptVersion): PromptDiff {
  const messages: PromptMessageDiff[] = [];
  const length = Math.max(from.messages.length, to.messages.length);
  for (let index = 0; index < length; index += 1) {
    const a = textOf(from.messages[index]);
    const b = textOf(to.messages[index]);
    const lines = diffLines(a?.text ?? '', b?.text ?? '');
    const role = a && b && a.role !== b.role ? `${a.role} → ${b.role}` : ((b ?? a) as { role: string }).role;
    const change = !a
      ? 'added'
      : !b
        ? 'removed'
        : a.role !== b.role || lines.some((line) => line.op !== '=')
          ? 'changed'
          : 'unchanged';
    messages.push({ index, change, role, lines });
  }
  const partials = diffFields(from.partials, to.partials);
  const config = diffFields(from.config as Record<string, unknown>, to.config as Record<string, unknown>);
  const defaults = diffFields(from.defaults, to.defaults);
  return {
    name: to.name,
    from: from.version,
    to: to.version,
    changed: from.version !== to.version,
    messages,
    partials,
    config,
    defaults,
  };
}

/** A diff as text, for a terminal, a log, or a pull-request comment. */
export function formatPromptDiff(diff: PromptDiff): string {
  const lines = [`${diff.name}: ${diff.from} → ${diff.to}`];
  if (!diff.changed) return `${lines[0]} (unchanged)`;
  for (const message of diff.messages) {
    if (message.change === 'unchanged') continue;
    lines.push(`@@ message ${message.index} (${message.role}) ${message.change}`);
    for (const line of message.lines) lines.push(`${line.op === '=' ? ' ' : line.op} ${line.text}`);
  }
  for (const [section, changes] of [
    ['partials', diff.partials],
    ['config', diff.config],
    ['defaults', diff.defaults],
  ] as const) {
    for (const change of changes) {
      const show = (value: unknown) => (value === undefined ? '(none)' : canonicalJson(value));
      lines.push(`@@ ${section}.${change.key}: ${show(change.before)} → ${show(change.after)}`);
    }
  }
  return lines.join('\n');
}
