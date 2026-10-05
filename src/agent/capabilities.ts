import type { ToolDefinition } from '../types/messages.js';

/**
 * Capabilities: what a tool does to the world, written as strings a policy can decide on.
 *
 * | Capability | Means |
 * | --- | --- |
 * | `filesystem:read`, `filesystem:read:<path>` | Reads files, or one path |
 * | `filesystem:write`, `filesystem:write:<path>` | Writes, creates, or deletes files |
 * | `network`, `network:<host or URL>` | Opens a network connection, to a host when given |
 * | `shell`, `shell:<command line>` | Runs a shell command |
 * | `code` | Runs code it was given, as an interpreter does |
 * | `<name>`, `<name>:<detail>` | Anything the application names, such as `payments:refund` |
 *
 * A tool that declares `capabilities: []` does nothing to the world; one that declares none at all
 * is undeclared, and a policy decides on it as such.
 */

/** One capability, split into its parts. */
export interface ParsedCapability {
  /** `filesystem`, `network`, `shell`, `code`, or the application's own name. */
  kind: string;
  /** `read` or `write`, for the filesystem. */
  access?: 'read' | 'write';
  /** The path, host, command, or detail, when the capability names one. */
  target?: string;
}

/** Splits a capability string into its kind, access, and target. */
export function parseCapability(capability: string): ParsedCapability {
  const text = capability.trim();
  const colon = text.indexOf(':');
  const kind = (colon < 0 ? text : text.slice(0, colon)).toLowerCase();
  const rest = colon < 0 ? undefined : text.slice(colon + 1);
  if (kind === 'filesystem') {
    if (!rest) return { kind };
    const [access, ...path] = rest.split(':');
    const parsed: ParsedCapability = { kind };
    if (access === 'read' || access === 'write') parsed.access = access;
    const target = parsed.access ? path.join(':') : rest;
    if (target) parsed.target = target;
    return parsed;
  }
  return rest === undefined || rest === '' ? { kind } : { kind, target: rest };
}

/**
 * The capabilities one call of a tool declares: its static list, or what its function computes from
 * the call's arguments. `undefined` means undeclared — no list, or a function that threw — which is
 * not the same as `[]`, a tool that declares it does nothing to the world.
 */
export function capabilitiesOf(
  tool: Pick<ToolDefinition, 'capabilities'> | undefined,
  args: Record<string, unknown>,
): string[] | undefined {
  const declared = tool?.capabilities;
  if (!declared) return undefined;
  if (typeof declared !== 'function') return [...declared];
  try {
    return [...declared(args)];
  } catch {
    return undefined;
  }
}

/**
 * Whether a capability is sensitive: anything but reading files. A pure tool declares
 * `capabilities: []`; whatever it does declare, a write, a command, code, the network, or an
 * effect of the application's own such as `payments`, changes the world or leaves the process.
 */
export function isSensitiveCapability(capability: string): boolean {
  const parsed = parseCapability(capability);
  return !(parsed.kind === 'filesystem' && parsed.access === 'read');
}
