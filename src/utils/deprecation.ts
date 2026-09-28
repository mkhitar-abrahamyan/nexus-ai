/**
 * One warning per deprecated option per process, through Node's own `DeprecationWarning` channel.
 *
 * Going through `process.emitWarning` rather than the console means the platform's switches apply:
 * `--no-deprecation` silences these, `--throw-deprecation` turns them into errors for a CI job that
 * must stay clean, and `process.on('warning')` sees them. Where there is no `process`, such as a
 * browser, the warning goes to `console.warn` instead.
 */

const warned = new Set<string>();

/** Warns once that a deprecated option was used. `code` identifies it, as `NEXUS_DEP_*`. */
export function warnDeprecated(code: string, message: string): void {
  if (warned.has(code)) return;
  warned.add(code);
  const runtime = (globalThis as { process?: { emitWarning?: (message: string, options: object) => void } }).process;
  if (typeof runtime?.emitWarning === 'function') {
    runtime.emitWarning(message, { type: 'DeprecationWarning', code });
  } else {
    console.warn(`DeprecationWarning [${code}]: ${message}`);
  }
}

/** Warns when an option is present, for the options that have never been read. */
export function warnUnreadOption(present: boolean, code: string, option: string): void {
  if (present) warnDeprecated(code, `${option} has never been read and will be removed in 2.0. Remove it.`);
}
