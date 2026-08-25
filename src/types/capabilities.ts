/**
 * How the runtime reacts when a request asks for something the target model does not declare.
 *
 * - `strict` throws a `NexusCapabilityError` before the provider is called.
 * - `warn` removes the option, records a `CapabilityWarning`, and continues.
 * - `off` sends the request unchanged, so a provider feature that is newer than the bundled
 *   registry is never blocked by stale metadata.
 *
 * An option the model does not mention at all is always allowed: absence means unknown, not
 * unsupported. Only an explicit `false`, or a value outside a declared constraint, is refused.
 */
export type CapabilityPolicy = 'strict' | 'warn' | 'off';

/** What happened to a requested option that the model could not honor as written. */
export type CapabilityWarningAction = 'dropped' | 'adjusted';

export interface CapabilityWarning {
  /** Dotted request path, such as `reasoning.effort` or `cache.mode`. */
  feature: string;
  model: string;
  provider?: string;
  requested?: unknown;
  action: CapabilityWarningAction;
  /** Value actually sent, when the option was clamped rather than removed. */
  adjustedTo?: unknown;
  reason: string;
}

export interface CapabilityConfig {
  /** Default policy for every operation. Defaults to `warn`. */
  policy?: CapabilityPolicy;
  /**
   * Emit a one-time console warning the first time a deprecated or floating alias resolves.
   * Off by default so libraries do not write to a host application's logs uninvited.
   */
  warnOnAliasStage?: boolean;
}
