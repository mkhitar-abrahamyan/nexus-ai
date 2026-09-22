/** Base class for prompt errors, each with a stable `code`. */
export class PromptError extends Error {
  constructor(
    message: string,
    /** Stable code, such as `PROMPT_RENDER_ERROR`. */
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PromptError';
  }
}

/** Raised when a definition is invalid: an unknown or recursive partial, or a malformed placeholder. */
export class PromptDefinitionError extends PromptError {
  constructor(message: string) {
    super(message, 'PROMPT_DEFINITION_ERROR');
    this.name = 'PromptDefinitionError';
  }
}

/** Raised when rendering is missing variables and `missing` is `error`, the default. */
export class PromptRenderError extends PromptError {
  constructor(
    /** The prompt. */
    public readonly prompt: string,
    /** Every variable that had no value. */
    public readonly missing: readonly string[],
  ) {
    super(`Prompt "${prompt}" is missing ${missing.map((name) => `"${name}"`).join(', ')}`, 'PROMPT_RENDER_ERROR');
    this.name = 'PromptRenderError';
  }
}

/** Raised when a prompt, a version, or a label does not exist. */
export class PromptNotFoundError extends PromptError {
  constructor(
    /** The prompt. */
    public readonly prompt: string,
    /** The version or label looked up. */
    public readonly ref: string,
  ) {
    super(`Prompt "${prompt}" has no version or label "${ref}"`, 'PROMPT_NOT_FOUND');
    this.name = 'PromptNotFoundError';
  }
}

/** Raised when a label moved while it was being changed, so the change was not applied. */
export class PromptConflictError extends PromptError {
  constructor(
    /** The prompt. */
    public readonly prompt: string,
    /** The label that moved. */
    public readonly label: string,
  ) {
    super(`Label "${label}" of prompt "${prompt}" was changed by another writer; reload and retry`, 'PROMPT_CONFLICT');
    this.name = 'PromptConflictError';
  }
}

/** The verdict of one promotion gate. */
export interface GateResult {
  /** Names the gate in reports. */
  gate: string;
  /** Whether it allows the promotion. */
  ok: boolean;
  /** Why it refused, or what it checked. */
  reason?: string;
}

/** Raised when a gate refuses a promotion. Nothing moved. */
export class PromptPromotionError extends PromptError {
  constructor(
    /** The prompt. */
    public readonly prompt: string,
    /** The label it was to be promoted to. */
    public readonly to: string,
    /** Every gate's verdict, the refusals included. */
    public readonly results: readonly GateResult[],
  ) {
    const refused = results.filter((result) => !result.ok);
    super(
      `Promotion of "${prompt}" to "${to}" was refused: ${refused
        .map((result) => `${result.gate}${result.reason ? ` (${result.reason})` : ''}`)
        .join('; ')}`,
      'PROMPT_PROMOTION_REFUSED',
    );
    this.name = 'PromptPromotionError';
  }
}
