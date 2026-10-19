/**
 * Data residency: which regions a tenant's requests and data may reach, and where each provider,
 * replica, and store runs.
 */

/** What runs in one region. */
export interface RegionDefinition {
  /** Providers that run in this region, by the name each is registered under. */
  providers?: readonly string[];
  /**
   * A provider outside this region mapped to its twin inside it, serving the same models, such as
   * `{ openai: 'openai-eu' }`: a request routed to the first is sent to the twin instead.
   */
  twins?: Readonly<Record<string, string>>;
}

/** Which regions an operation may reach, and the rule that says so. */
export interface ResidencyDecision {
  /** The tenant it runs for. */
  tenantId?: string;
  /** The regions it may reach, the first its home; `undefined` when it may reach any. */
  regions?: readonly string[];
  /** The rule that decided, as a refusal quotes it, such as `tenant acme: eu-west, eu-central`. */
  rule: string;
}

/** Something a request or its data could reach, as a residency check names it. */
export interface ResidencyTarget {
  /** What kind of thing it is: a provider, a replica, a trace store, an asset store, or another. */
  kind: 'provider' | 'replica' | 'region' | 'trace-store' | 'asset-store' | (string & {});
  /** Its name. */
  name: string;
  /** The region it is in, when it is in one. */
  region?: string;
}

/** Where a call to a provider is placed under a decision: the provider itself, or its twin. */
export interface ResidencyPlacement {
  /** The provider to call. */
  provider: string;
  /** The region it runs in, or `undefined` when the decision allows any region and none is known. */
  region?: string;
}

/**
 * A residency policy, from `residency()` in `nexus-ai-pro/residency`: which regions each tenant may
 * reach, and what runs where.
 */
export interface ResidencyPolicy {
  /** The regions a tenant's operations may reach, the first its home, and the rule that says so. */
  regionsFor(tenantId: string | undefined): Promise<ResidencyDecision> | ResidencyDecision;
  /** The region a provider runs in, or `undefined` when no region lists it. */
  regionOf(provider: string): string | undefined;
  /** Where a call to a provider goes under a decision: itself, its twin in an allowed region, or nowhere. */
  place(provider: string, decision: ResidencyDecision): ResidencyPlacement | undefined;
  /** Whether a decision allows a region. A region of `undefined` is allowed only when every region is. */
  allows(region: string | undefined, decision: ResidencyDecision): boolean;
  /** Throws a `ResidencyError` when a target is outside a decision's regions. */
  check(target: ResidencyTarget, decision: ResidencyDecision): void;
}

/** What an operation's residency gives the families that call providers: its decision, and a check per provider. */
export interface CallResidency {
  /** The operation's decision. */
  decision: ResidencyDecision;
  /** Whether a provider may be called: it, not a twin, runs in an allowed region. */
  allows(provider: string): boolean;
  /** Where a call to a provider is placed: itself, its twin, or nowhere. */
  place(provider: string): ResidencyPlacement | undefined;
  /** Throws a `ResidencyError` for a provider outside the decision's regions. */
  check(provider: string): void;
}
