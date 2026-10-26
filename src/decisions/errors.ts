/** Why a decision failed, apart from the rest of the contract, so every part of it can raise one. */

/** Why a decision failed. */
export type DecisionErrorCode =
  | 'DECISION_NO_PROVIDER'
  | 'DECISION_UNSUPPORTED'
  | 'DECISION_INVALID'
  | 'DECISION_FAILED';

/** Raised for a decision no provider can serve, a question that is malformed, or a provider's failure. */
export class DecisionError extends Error {
  constructor(
    message: string,
    /**
     * A stable code: `DECISION_NO_PROVIDER`, `DECISION_UNSUPPORTED` (a provider cannot take the
     * question), `DECISION_INVALID` (the request, or an answer, is malformed), or `DECISION_FAILED`.
     */
    readonly code: DecisionErrorCode,
    /** Whether asking again, or another provider, may help: a timeout or an overloaded service may. */
    readonly retryable = false,
    /** The HTTP status a provider answered with, when it did. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}
