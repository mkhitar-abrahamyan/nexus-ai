import type { ResidencyDecision, ResidencyTarget } from '../types/residency.js';

/**
 * Raised when a request, or its data, would reach something outside the regions its tenant may
 * reach: a provider, a replica, a trace store, or an asset store. Nothing is sent.
 */
export class ResidencyError extends Error {
  /** Stable code for the refusal. */
  readonly code = 'RESIDENCY_DENIED';
  /** What it would have reached. */
  readonly target: ResidencyTarget;
  /** The tenant it ran for. */
  readonly tenantId?: string;
  /** The regions the tenant may reach. */
  readonly regions?: readonly string[];
  /** The rule that held it back, such as `tenant acme: eu-west`. */
  readonly rule: string;

  constructor(target: ResidencyTarget, decision: ResidencyDecision, detail?: string) {
    const where = target.region ? `runs in ${target.region}` : 'is in no region';
    super(
      `${target.kind} ${target.name} ${where}, outside the regions ${
        decision.tenantId ? `tenant ${decision.tenantId}` : 'this operation'
      } may reach (${decision.rule})${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'ResidencyError';
    this.target = target;
    if (decision.tenantId !== undefined) this.tenantId = decision.tenantId;
    if (decision.regions) this.regions = decision.regions;
    this.rule = decision.rule;
  }
}
