import type { OperationStatus } from '../types/operations.js';

/** Base class for durable-operation errors, each with a stable `code`. */
export class OperationError extends Error {
  constructor(
    message: string,
    /** Stable code, such as `OPERATION_CANCELLED`. */
    public readonly code: string,
    /** The underlying error. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

/** Raised when work is attempted on a cancelled operation. */
export class OperationCancelledError extends OperationError {
  constructor(
    /** The operation. */
    public readonly operationId: string,
    /** Why it was cancelled. */
    public readonly reason?: string,
  ) {
    super(
      reason ? `Operation "${operationId}" was cancelled: ${reason}` : `Operation "${operationId}" was cancelled`,
      'OPERATION_CANCELLED',
    );
    this.name = 'OperationCancelledError';
  }
}

/** Raised when an operation passes its expiry before completing. */
export class OperationExpiredError extends OperationError {
  constructor(
    /** The operation. */
    public readonly operationId: string,
    /** ISO-8601 time it expired. */
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
    /** The status it was in. */
    public readonly from: OperationStatus,
    /** The status it was asked to move to. */
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
    /** The operation. */
    public readonly operationId: string,
    /** The sequence the losing write expected. */
    public readonly expectedSequence: number,
  ) {
    super(
      `Operation "${operationId}" was modified by another worker; expected sequence ${expectedSequence}`,
      'OPERATION_CONFLICT',
    );
    this.name = 'OperationConflictError';
  }
}

/** Raised when a worker's lease on an operation was taken over by another worker. */
export class OperationLeaseLostError extends OperationError {
  constructor(
    /** The operation. */
    public readonly operationId: string,
    /** The worker whose lease was lost. */
    public readonly owner: string,
  ) {
    super(`Operation "${operationId}" lease held by "${owner}" was taken over`, 'OPERATION_LEASE_LOST');
    this.name = 'OperationLeaseLostError';
  }
}

/**
 * Raised by a store that enforces unique idempotency keys when a second record claims one.
 *
 * Two workers can both find no record for a key and both try to create one; a store that can say
 * which one lost lets the runner attach the loser to the winner's operation instead of running the
 * work twice.
 */
export class OperationDuplicateError extends OperationError {
  constructor(
    /** The key already claimed. */
    public readonly idempotencyKey: string,
  ) {
    super(`An operation with idempotency key "${idempotencyKey}" already exists`, 'OPERATION_DUPLICATE');
    this.name = 'OperationDuplicateError';
  }
}

/** Raised when an operation id is not in the store. */
export class OperationNotFoundError extends OperationError {
  constructor(
    /** The id looked up. */
    public readonly operationId: string,
  ) {
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
    /** The operation. */
    public readonly operationId: string,
    /** Where in the result the bytes were found. */
    public readonly path: string,
  ) {
    super(
      `Operation "${operationId}" cannot persist binary data at ${path}. Store the bytes through an AssetStore and keep an asset reference on the result instead.`,
      'OPERATION_SERIALIZATION_ERROR',
    );
    this.name = 'OperationSerializationError';
  }
}
