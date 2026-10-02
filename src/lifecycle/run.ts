import type {
  OperationDescriptor,
  OperationLifecycleLike,
  OperationResultInfo,
  OperationStartOptions,
  OperationTicket,
} from '../types/lifecycle.js';

/** An operation as a module outside the core describes it; the lifecycle fills in the request id. */
export type OperationInput = Omit<OperationDescriptor, 'requestId'> & { requestId?: string };

/**
 * Runs `execute` as one operation of `lifecycle`, or plainly when there is none. Modules that only
 * take a lifecycle as an option use this, so they depend on its types alone.
 */
export async function withLifecycle<T>(
  lifecycle: OperationLifecycleLike | undefined,
  operation: OperationInput,
  options: OperationStartOptions,
  execute: (ticket: OperationTicket | undefined) => Promise<T>,
  settle?: (result: T) => OperationResultInfo,
): Promise<T> {
  if (!lifecycle) return execute(undefined);
  const ticket = await lifecycle.start(operation, options);
  try {
    const result = await execute(ticket);
    await ticket.succeed(settle?.(result));
    return result;
  } catch (error) {
    await ticket.fail(error);
    throw error;
  }
}
