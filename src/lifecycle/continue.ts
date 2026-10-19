import type { OperationDescriptor, OperationLifecycleLike, ProviderCallContext } from '../types/lifecycle.js';

/** What a continued call adds to the context its family gives the provider. */
export type ContinuedFields = Pick<ProviderCallContext, 'tenantId' | 'credential' | 'residency'>;

/**
 * Runs a provider call that continues an operation outside it, such as polling a job by its ref:
 * with the tenant's credentials and inside its regions when the lifecycle can give them, and its
 * errors cleaned of every credential it resolved. Without a lifecycle, or one that cannot, the call
 * runs as it is, on the configured key.
 */
export async function continuing<T>(
  lifecycle: OperationLifecycleLike | undefined,
  operation: Omit<OperationDescriptor, 'requestId'> & { requestId?: string },
  call: (context: ContinuedFields) => Promise<T>,
): Promise<T> {
  const continued = await lifecycle?.callContext?.(operation);
  if (!continued) return call({});
  const { scrub, ...context } = continued;
  try {
    if (operation.provider) context.residency?.check(operation.provider, operation.model);
    return await call(context);
  } catch (error) {
    throw scrub(error);
  }
}
