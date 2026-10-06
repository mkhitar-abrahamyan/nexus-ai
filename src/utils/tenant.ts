import type { Principal } from '../types/principal.js';

/**
 * The tenant id rule every scope shares. An id is letters, digits, `_`, and `-`, so it can never hold
 * the `/` a scoped name or key is built with: no tenant's prefix is a prefix of another's.
 */

/** Refused when a tenant id is empty, too long, or holds a character a scoped key could be split on. */
export class TenantIdError extends RangeError {
  /** Always `TENANT_ID_INVALID`. */
  readonly code = 'TENANT_ID_INVALID';

  constructor(tenantId: unknown) {
    super(`"${String(tenantId)}" is not a valid tenant id: use 1 to 128 letters, digits, underscores, and hyphens`);
    this.name = 'TenantIdError';
  }
}

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Returns a tenant id unchanged, or throws `TenantIdError` when it is not one. */
export function assertTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) throw new TenantIdError(tenantId);
  return tenantId;
}

/** @internal The prefix a tenant's names and keys carry in a shared store. */
export function tenantPrefix(tenantId: string): string {
  return `tenant/${assertTenantId(tenantId)}/`;
}

/**
 * Run options with the principal's tenant applied: the principal's `tenantId` becomes the run's when
 * it has none, a run whose two tenants differ is refused, and the principal's `userId` is recorded
 * in the run's metadata.
 */
export function withPrincipal<
  O extends { tenantId?: string; principal?: Principal; metadata?: Record<string, unknown> },
>(runOptions: O): O {
  const principal = runOptions.principal;
  if (!principal) return runOptions;
  const tenantId = principal.tenantId;
  if (tenantId !== undefined && runOptions.tenantId !== undefined && tenantId !== runOptions.tenantId) {
    throw new TypeError("The run's tenantId and its principal's tenant differ");
  }
  return {
    ...runOptions,
    ...(tenantId !== undefined && runOptions.tenantId === undefined ? { tenantId } : {}),
    ...(principal.userId !== undefined ? { metadata: { ...runOptions.metadata, userId: principal.userId } } : {}),
  };
}
