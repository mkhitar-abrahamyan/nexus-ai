/** Base class for server errors. Each carries the HTTP status the server answers with. */
export class ServerError extends Error {
  constructor(
    message: string,
    /** Stable code, such as `THREAD_BUSY`, sent in the error body. */
    public readonly code: string,
    /** HTTP status the server answers with. */
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

/** Raised when a request names something that does not exist, or belongs to another tenant. */
export class NotFoundError extends ServerError {
  constructor(what: string, id: string) {
    super(`${what} "${id}" was not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

/** Raised when a request is malformed: bad JSON, a missing field, or an unknown assistant. */
export class BadRequestError extends ServerError {
  constructor(message: string, code = 'BAD_REQUEST') {
    super(message, code, 400);
    this.name = 'BadRequestError';
  }
}

/** Raised when a request carries no usable credentials. */
export class UnauthorizedError extends ServerError {
  constructor(message = 'Authentication is required') {
    super(message, 'UNAUTHORIZED', 401);
    this.name = 'UnauthorizedError';
  }
}

/** Raised when a principal is known but not allowed to do this. */
export class ForbiddenError extends ServerError {
  constructor(
    /** The scope the route required. */
    public readonly scope: string,
  ) {
    super(`This request requires the "${scope}" scope`, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

/** Raised when a thread is already running something and the busy policy is `reject`. */
export class ThreadBusyError extends ServerError {
  constructor(
    /** The thread. */
    public readonly threadId: string,
    /** The run already in flight. */
    public readonly runId: string,
  ) {
    super(`Thread "${threadId}" is already running "${runId}"`, 'THREAD_BUSY', 409);
    this.name = 'ThreadBusyError';
  }
}

/** Raised when an assistant cannot do what a request needs, such as resuming or rolling back. */
export class AssistantCapabilityError extends ServerError {
  constructor(
    /** The assistant. */
    public readonly assistant: string,
    /** What it cannot do. */
    public readonly capability: string,
  ) {
    super(`Assistant "${assistant}" does not support ${capability}`, 'ASSISTANT_CAPABILITY', 409);
    this.name = 'AssistantCapabilityError';
  }
}
