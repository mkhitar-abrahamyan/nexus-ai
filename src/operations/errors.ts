import type { OperationStatus } from '../types/operations.js';

export class OperationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

export class OperationCancelledError extends OperationError {
  constructor(
    public readonly operationId: string,
    public readonly reason?: string,
  ) {
    super(
      reason ? `Operation "${operationId}" was cancelled: ${reason}` : `Operation "${operationId}" was cancelled`,
      'OPERATION_CANCELLED',
    );
    this.name = 'OperationCancelledError';
  }
}

export class OperationExpiredError extends OperationError {
  constructor(
    public readonly operationId: string,
    public readonly expiresAt?: string,
  ) {
    super(
      expiresAt
        ? `Operation "${operationId}" expired at ${expiresAt}`
        : `Operation "${operationId}" expired before it completed`,
      'OPERATION_EXPIRED',
    );
    this.name = 'OperationExpiredError';
  }
}

/**
 * Raised when a transition would leave the lifecycle in an impossible state.
 *
 * This is a programming error in a runner or a custom store, never something a provider can cause,
 * so it is deliberately loud rather than tolerated.
 */
export class OperationTransitionError extends OperationError {
  constructor(
    public readonly from: OperationStatus,
    public readonly to: OperationStatus,
    operationId?: string,
  ) {
    super(
      `Operation${operationId ? ` "${operationId}"` : ''} cannot move from ${from} to ${to}`,
      'OPERATION_INVALID_TRANSITION',
    );
    this.name = 'OperationTransitionError';
  }
}

/**
 * Raised when a compare-and-set update loses to another worker.
 *
 * The losing worker must reload the record rather than retry its write, because the winner may
 * have cancelled or completed the operation.
 */
export class OperationConflictError extends OperationError {
  constructor(
    public readonly operationId: string,
    public readonly expectedSequence: number,
  ) {
    super(
      `Operation "${operationId}" was modified by another worker; expected sequence ${expectedSequence}`,
      'OPERATION_CONFLICT',
    );
    this.name = 'OperationConflictError';
  }
}

export class OperationLeaseLostError extends OperationError {
  constructor(
    public readonly operationId: string,
    public readonly owner: string,
  ) {
    super(`Operation "${operationId}" lease held by "${owner}" was taken over`, 'OPERATION_LEASE_LOST');
    this.name = 'OperationLeaseLostError';
  }
}

export class OperationNotFoundError extends OperationError {
  constructor(public readonly operationId: string) {
    super(`Operation "${operationId}" is not in the store`, 'OPERATION_NOT_FOUND');
    this.name = 'OperationNotFoundError';
  }
}

/**
 * Raised when a result carrying raw bytes is about to be persisted.
 *
 * Binary media must be stored as an asset reference, not serialized into the operation record: a
 * base64 round trip inflates the payload by a third, and a queue backend usually caps job size well
 * below one image.
 */
export class OperationSerializationError extends OperationError {
  constructor(
    public readonly operationId: string,
    public readonly path: string,
  ) {
    super(
      `Operation "${operationId}" cannot persist binary data at ${path}. Store the bytes through an AssetStore and keep an asset reference on the result instead.`,
      'OPERATION_SERIALIZATION_ERROR',
    );
    this.name = 'OperationSerializationError';
  }
}
