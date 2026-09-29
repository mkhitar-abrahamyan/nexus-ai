import { diffLines, type PromptLineChange } from '../prompts/diff.js';
import { canonicalJson } from '../prompts/version.js';
import type { ContextBundle } from './hub.js';

/** One entry that differs between two bundle versions. */
export interface ContextChange {
  /** The part of the bundle. */
  section: 'description' | 'prompts' | 'instructions' | 'tools' | 'skills' | 'config';
  /** The entry within it: a prompt role, an instruction or skill name, a tool name, or a config key. */
  key: string;
  /** Whether the entry was added, removed, or changed. */
  change: 'added' | 'removed' | 'changed';
  /** Line by line, for text: an instruction, a skill's instructions, or the description. */
  lines?: PromptLineChange[];
  /** The entry before, for anything that is not text. */
  before?: unknown;
  /** The entry after, for anything that is not text. */
  after?: unknown;
}

/** What changed between two versions of a bundle. */
export interface ContextDiff {
  /** The bundle. */
  name: string;
  /** The earlier version. */
  from: string;
  /** The later version. */
  to: string;
  /** Every entry that differs, section by section. */
  changes: ContextChange[];
}

/** Compares two versions of a bundle, entry by entry, with line diffs for text. */
export function diffContexts(from: ContextBundle, to: ContextBundle): ContextDiff {
  const changes: ContextChange[] = [];
  if ((from.description ?? '') !== (to.description ?? '')) {
    changes.push({
      section: 'description',
      key: 'description',
      change: from.description === undefined ? 'added' : to.description === undefined ? 'removed' : 'changed',
      lines: diffLines(from.description ?? '', to.description ?? ''),
    });
  }
  compare(changes, 'prompts', from.prompts, to.prompts);
  compare(changes, 'instructions', from.instructions, to.instructions, (value) => value as string);
  compare(
    changes,
    'tools',
    Object.fromEntries((from.tools ?? []).map((tool) => [tool.name, tool])),
    Object.fromEntries((to.tools ?? []).map((tool) => [tool.name, tool])),
  );
  compare(changes, 'skills', from.skills, to.skills, (value) => {
    const skill = value as { description: string; instructions: string; resources?: Record<string, string> };
    return `${skill.description}\n\n${skill.instructions}${Object.entries(skill.resources ?? {})
      .map(([name, text]) => `\n\n[${name}]\n${text}`)
      .join('')}`;
  });
  compare(changes, 'config', from.config, to.config);
  return { name: to.name, from: from.version, to: to.version, changes };
}

/** A diff as text, one line per change and `+`/`-` lines for text, for a terminal or a pull request. */
export function formatContextDiff(diff: ContextDiff): string {
  const lines = [`${diff.name}: ${diff.from} -> ${diff.to}`];
  if (diff.changes.length === 0) lines.push('  no changes');
  for (const change of diff.changes) {
    lines.push(`  ${change.change} ${change.section}.${change.key}`);
    for (const line of change.lines ?? []) {
      if (line.op !== '=') lines.push(`    ${line.op} ${line.text}`);
    }
    if (!change.lines && change.change === 'changed') {
      lines.push(`    - ${canonicalJson(change.before)}`, `    + ${canonicalJson(change.after)}`);
    }
  }
  return lines.join('\n');
}

function compare(
  changes: ContextChange[],
  section: ContextChange['section'],
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  asText?: (value: unknown) => string,
): void {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  for (const key of keys) {
    const was = before?.[key];
    const is = after?.[key];
    if (was !== undefined && is !== undefined && canonicalJson(was) === canonicalJson(is)) continue;
    const change = was === undefined ? 'added' : is === undefined ? 'removed' : 'changed';
    changes.push(
      asText
        ? {
            section,
            key,
            change,
            lines: diffLines(was === undefined ? '' : asText(was), is === undefined ? '' : asText(is)),
          }
        : {
            section,
            key,
            change,
            ...(was === undefined ? {} : { before: was }),
            ...(is === undefined ? {} : { after: is }),
          },
    );
  }
}
