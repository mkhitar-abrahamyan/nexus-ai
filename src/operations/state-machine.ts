import type { OperationStatus } from '../types/operations.js';
import { isTerminalOperationStatus } from '../types/operations.js';
import { OperationTransitionError } from './errors.js';

/**
 * Legal moves through the operation lifecycle.
 *
 * Written out rather than inferred so the whole contract is readable in one place. Three rules are
 * worth stating explicitly, because each one prevented a real class of bug in the process-local
 * image handle this generalizes:
 *
 * - `cancelling` can still reach `succeeded` or `failed`. Cancellation asks an executor to stop; it
 *   does not guarantee it stopped in time, and reporting a discarded success as a cancellation
 *   would lose a result the provider already charged for.
 * - `retrying` returns to `queued`, never straight to `running`. A retry re-enters the queue so a
 *   different worker may pick it up, which is what makes recovery after a crash work.
 * - Nothing leaves a terminal status. A late provider callback cannot resurrect a cancelled
 *   operation.
 */
const TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  queued: ['running', 'cancelling', 'cancelled', 'expired'],
  running: ['running', 'succeeded', 'failed', 'retrying', 'cancelling', 'cancelled', 'expired'],
  retrying: ['queued', 'running', 'failed', 'cancelling', 'cancelled', 'expired'],
  cancelling: ['cancelled', 'succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OperationStatus, to: OperationStatus, operationId?: string): void {
  if (!canTransition(from, to)) throw new OperationTransitionError(from, to, operationId);
}

/** Statuses reachable from `from`, for building a UI or validating a custom runner. */
export function allowedTransitions(from: OperationStatus): readonly OperationStatus[] {
  return TRANSITIONS[from];
}

export { isTerminalOperationStatus };

/** True when the operation is finished and a worker should stop touching it. */
export function isSettled(status: OperationStatus): boolean {
  return isTerminalOperationStatus(status);
}

/** True when a worker may claim the operation and start executing. */
export function isClaimable(status: OperationStatus): boolean {
  return status === 'queued' || status === 'retrying';
}
