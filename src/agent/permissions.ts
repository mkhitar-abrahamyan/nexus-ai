/**
 * Permission policies: what an agent's tools may do, decided per call from what each call declares.
 *
 * Danger belongs to what a tool does, not to its name. A tool declares capabilities — a path it
 * writes, a host it calls, a command it runs — and a policy grants filesystem paths, network hosts,
 * and shell commands, and decides every call: allow it, deny it, or ask a person first. A call is
 * denied when any of its capabilities is, asked about when any needs approval, and allowed only when
 * every one is granted.
 */
import type { Principal } from '../types/principal.js';
import { parseCapability } from './capabilities.js';

export { capabilitiesOf, isSensitiveCapability, type ParsedCapability, parseCapability } from './capabilities.js';

/** What a policy decides for one call: run it, refuse it, or interrupt for a person's approval. */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** One tool call, as a policy sees it. */
export interface PermissionRequest {
  /** The tool's name. */
  tool: string;
  /** The call's arguments. */
  args: Record<string, unknown>;
  /** What the call declares it does, or `undefined` when the tool declares nothing. */
  capabilities: readonly string[] | undefined;
  /** Who the run is for, when it has a principal, so a policy of your own can decide by role or scope. */
  principal?: Readonly<Principal>;
}

/** A policy's decision, with the reason a person or a model reads. */
export interface PermissionVerdict {
  /** The decision. */
  decision: PermissionDecision;
  /** Why, naming the capability that decided it. */
  reason: string;
  /** The capability that decided it, when one did. */
  capability?: string;
}

/** Anything that decides tool calls. `createAgent({ permissions })` takes one. */
export interface PermissionPolicyLike {
  /** Decides one call. */
  decide(request: PermissionRequest): PermissionVerdict | Promise<PermissionVerdict>;
}

/** What a policy grants. Anything not granted is denied unless `ungranted` says otherwise. */
export interface PermissionRules {
  /**
   * Paths a tool may read and write, as globs: `*` within one path segment, `**` across segments, so
   * `/workspace/**` is the workspace and everything in it. A write grant also allows reading.
   */
  filesystem?: { read?: readonly string[]; write?: readonly string[] };
  /** Hosts a tool may reach: `api.github.com`, `*.openai.com` for its subdomains, or `*` for any. */
  network?: { allow?: readonly string[] };
  /**
   * Commands a tool may run, each the start of a command line: `git` allows every git command, and
   * `npm test` only that. A command line that chains, pipes, redirects, or substitutes is never
   * granted by these, only by `*`.
   */
  shell?: { allow?: readonly string[] };
  /** Running code a tool was given. Defaults to `deny`; a sandboxed interpreter is the place for `ask` or `allow`. */
  code?: PermissionDecision;
  /** Decisions for the application's own capabilities, by kind or by full capability: `{ payments: 'ask' }`. */
  custom?: Readonly<Record<string, PermissionDecision>>;
  /**
   * Capabilities that need a person's approval even when granted, as patterns: `shell`,
   * `filesystem:write`, `network:*.stripe.com`, `payments`.
   */
  ask?: readonly string[];
  /** A tool that declares no capabilities. Defaults to `deny`: a policy cannot judge what it cannot see. */
  undeclared?: PermissionDecision;
  /** A capability no grant covers. Defaults to `deny`. */
  ungranted?: 'ask' | 'deny';
  /** Decisions per tool name, applied before anything else. */
  tools?: Readonly<Record<string, PermissionDecision>>;
  /** What a relative path is resolved against. Defaults to `/`. */
  root?: string;
}

const ORDER: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };
const CHAINING = /[;&|`$<>\n\r]/;

/**
 * Builds a policy from what it grants.
 *
 * ```ts
 * const permissions = permissionPolicy({
 *   filesystem: { read: ['/workspace/**'], write: ['/workspace/output/**'] },
 *   network: { allow: ['api.github.com', '*.openai.com'] },
 *   shell: { allow: ['git', 'npm test'] },
 *   ask: ['shell', 'filesystem:write'],
 * });
 * const agent = createAgent({ client, tools, permissions, checkpointer });
 * ```
 */
export function permissionPolicy(rules: PermissionRules): PermissionPolicy {
  return new PermissionPolicy(rules);
}

/** A policy built from `PermissionRules`. Deterministic: the same call always gets the same decision. */
export class PermissionPolicy implements PermissionPolicyLike {
  constructor(
    /** What the policy grants. */
    readonly rules: PermissionRules,
  ) {}

  /** Decides one call from its declared capabilities. */
  decide(request: PermissionRequest): PermissionVerdict {
    const forced = this.rules.tools?.[request.tool];
    if (forced) return { decision: forced, reason: `"${request.tool}" is set to ${forced} by name` };
    if (request.capabilities === undefined) {
      const decision = this.rules.undeclared ?? 'deny';
      return {
        decision,
        reason: `"${request.tool}" declares no capabilities, so the policy cannot see what it does`,
      };
    }
    let verdict: PermissionVerdict = { decision: 'allow', reason: `every capability of "${request.tool}" is granted` };
    for (const capability of request.capabilities) {
      const next = this.decideOne(capability);
      if (ORDER[next.decision] > ORDER[verdict.decision]) verdict = next;
      if (verdict.decision === 'deny') break;
    }
    return verdict;
  }

  /** Decides one capability: granted or not, then whether it needs approval. */
  decideOne(capability: string): PermissionVerdict {
    const parsed = parseCapability(capability);
    // A reason names the path as judged, after `..` is resolved: `/etc/passwd`, not `/workspace/../../etc/passwd`.
    const shown = this.shown(capability, parsed);
    const granted = this.granted(parsed);
    if (granted === 'deny') {
      return { decision: this.rules.ungranted ?? 'deny', reason: `${shown} is not granted`, capability };
    }
    if (
      granted === 'ask' ||
      (this.rules.ask ?? []).some((pattern) => capabilityMatches(pattern, parsed, this.root()))
    ) {
      return { decision: 'ask', reason: `${shown} needs approval`, capability };
    }
    return { decision: 'allow', reason: `${shown} is granted`, capability };
  }

  private shown(capability: string, parsed: ReturnType<typeof parseCapability>): string {
    if (parsed.kind !== 'filesystem' || parsed.target === undefined) return capability;
    const resolved = normalizePath(parsed.target, this.root());
    return resolved === null ? capability : `filesystem:${parsed.access ?? 'write'}:${resolved}`;
  }

  private root(): string {
    return this.rules.root ?? '/';
  }

  private granted(parsed: ReturnType<typeof parseCapability>): PermissionDecision {
    switch (parsed.kind) {
      case 'filesystem': {
        const path = parsed.target === undefined ? undefined : normalizePath(parsed.target, this.root());
        if (path === null) return 'deny';
        const writes = this.rules.filesystem?.write ?? [];
        const reads = [...(this.rules.filesystem?.read ?? []), ...writes];
        const globs = parsed.access === 'read' ? reads : writes;
        const matches = (glob: string) =>
          path === undefined
            ? glob === '**' || glob === '/**'
            : globToRegExp(normalizePath(glob, this.root()) ?? '').test(path);
        return globs.some(matches) ? 'allow' : 'deny';
      }
      case 'network': {
        const host = parsed.target === undefined ? undefined : hostOf(parsed.target);
        const allowed = this.rules.network?.allow ?? [];
        return allowed.some((pattern) => hostMatches(pattern, host)) ? 'allow' : 'deny';
      }
      case 'shell': {
        const allowed = this.rules.shell?.allow ?? [];
        if (allowed.includes('*')) return 'allow';
        const command = parsed.target?.trim();
        if (!command || CHAINING.test(command)) return 'deny';
        const tokens = command.split(/\s+/);
        return allowed.some((entry) => {
          const prefix = entry.trim().split(/\s+/);
          return prefix.every((token, index) => tokens[index] === token);
        })
          ? 'allow'
          : 'deny';
      }
      case 'code':
        return this.rules.code ?? 'deny';
      default: {
        const custom = this.rules.custom ?? {};
        const full = parsed.target === undefined ? parsed.kind : `${parsed.kind}:${parsed.target}`;
        return custom[full] ?? custom[parsed.kind] ?? 'deny';
      }
    }
  }
}

/**
 * Whether a pattern such as `shell`, `filesystem:write`, or `network:*.stripe.com` covers a
 * capability: the same kind, the same access when the pattern names one, and a target the pattern's
 * glob matches when it names one.
 */
function capabilityMatches(pattern: string, capability: ReturnType<typeof parseCapability>, root: string): boolean {
  const wanted = parseCapability(pattern);
  if (wanted.kind !== capability.kind) return false;
  if (wanted.access && wanted.access !== capability.access) return false;
  if (wanted.target === undefined) return true;
  if (capability.target === undefined) return false;
  if (capability.kind === 'network') return hostMatches(wanted.target, hostOf(capability.target));
  if (capability.kind === 'filesystem') {
    const path = normalizePath(capability.target, root);
    return path !== null && globToRegExp(normalizePath(wanted.target, root) ?? '').test(path);
  }
  return globToRegExp(wanted.target).test(capability.target);
}

/**
 * A path made absolute and normalized, with `.` and `..` resolved, so `/workspace/../etc` is
 * `/etc` before any grant sees it. Backslashes count as separators. `null` for a path that could
 * never be safe to judge, such as one holding a NUL.
 */
export function normalizePath(path: string, root = '/'): string | null {
  if (path.includes('\0')) return null;
  const unified = path.replace(/\\/g, '/');
  const absolute = /^([A-Za-z]:)?\//.test(unified)
    ? unified
    : `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${unified}`;
  const drive = /^[A-Za-z]:/.exec(absolute)?.[0]?.toLowerCase() ?? '';
  const parts: string[] = [];
  for (const segment of absolute.slice(drive.length).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return `${drive}/${parts.join('/')}`;
}

/** A glob as a regular expression: `**` across segments, `*` within one, `?` one character. `dir/**` also matches `dir`. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*' && glob[index + 1] === '*') {
      const atEnd = index + 2 === glob.length;
      if (atEnd && source.endsWith('/')) {
        source = `${source.slice(0, -1)}(?:/.*)?`;
      } else {
        source += '.*';
      }
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

/** The host a network capability names, from a bare host or a URL. */
function hostOf(target: string): string {
  try {
    return new URL(target.includes('://') ? target : `https://${target}`).hostname.toLowerCase();
  } catch {
    return target.toLowerCase();
  }
}

function hostMatches(pattern: string, host: string | undefined): boolean {
  const wanted = pattern.trim().toLowerCase();
  if (wanted === '*') return true;
  if (host === undefined) return false;
  if (wanted.startsWith('*.')) return host.endsWith(wanted.slice(1)) && host.length > wanted.length - 1;
  return host === wanted;
}
