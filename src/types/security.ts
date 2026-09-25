/** How much protection a client applies, from none to maximal. */
export type SecurityLevel = 'off' | 'basic' | 'standard' | 'strict' | 'paranoid';

/**
 * A preset tuned for a kind of deployment. `developer` is the `standard` level; `startup` is `strict`
 * with output redaction; `enterprise` adds blocking injection detection and PII masking; `healthcare`
 * and `finance` are `paranoid`, blocking or masking PII respectively. Your own settings are merged
 * over the preset.
 */
export type SecurityPreset = 'developer' | 'startup' | 'enterprise' | 'healthcare' | 'finance';

/**
 * What a guardrail does with a match: let it through, block the request, mask the match, or record
 * it.
 */
export type SecurityAction = 'allow' | 'block' | 'mask' | 'flag';

/** Kinds of personal data and secrets the PII detector recognizes. */
export type PIIType = 'email' | 'phone' | 'credit-card' | 'ip-address' | 'aws-key' | 'private-key';

/** Prompt-injection detection on input. */
export interface InjectionDetectionConfig {
  /** Turns detection on. */
  enabled?: boolean;
  /**
   * Ignored: the patterns match or they do not.
   *
   * @deprecated Has never been read. It will be removed in 2.0.
   */
  sensitivity?: number;
  /** What a detection does: block the request, record it, or neutralize the text. */
  onDetection?: 'block' | 'flag' | 'transform';
  /** Extra patterns to treat as injection. */
  customPatterns?: RegExp[];
  /**
   * Similarity to example attacks, which catches rephrasings a pattern misses. In the pipeline it
   * compares hashed term vectors, so it needs no provider; for a real embedding model, use
   * `SemanticInjectionClassifier` with `embed` directly.
   */
  semantic?: {
    /** Turns the semantic check on. Off by default. */
    enabled?: boolean;
    /** Similarity at which a prompt is flagged, from 0 to 1. Defaults to 0.78. */
    threshold?: number;
    /** Example attacks to compare against, instead of the built-in ones. */
    examples?: string[];
  };
}

/** Detection of personal data in input. */
export interface PIIConfig {
  /** Turns detection on. */
  enabled?: boolean;
  /** Kinds of data to detect. */
  detect?: PIIType[];
  /**
   * What a match does: mask it, remove it, block the request, or record it. Defaults to `mask` at the
   * `strict` and `paranoid` levels and `flag` below them; `paranoid` also blocks.
   */
  action?: 'mask' | 'remove' | 'block' | 'flag';
  /** Character used for masking. Defaults to `█`. */
  maskChar?: string;
  /**
   * Keeps the data's shape when masking: letters and digits are replaced one for one and punctuation
   * stays. On by default; `false` replaces each match with a run of the mask character instead.
   */
  preserveFormat?: boolean;
}

/** Detection of credentials in input: private keys, cloud and payment keys, tokens, and secret assignments. */
export interface SecretDetectionConfig {
  /** Turns detection on. On by default at every level but `off`. */
  enabled?: boolean;
  /** What a match does: block the request, mask the secret, or record it. Defaults to `block`. */
  action?: 'block' | 'mask' | 'flag';
}

/**
 * Detection of risky URLs in input: loopback and cloud-metadata addresses, onion services, and URLs
 * carrying secret-like query parameters.
 */
export interface UrlRiskConfig {
  /** Turns detection on. On by default at every level but `off`. */
  enabled?: boolean;
  /** What a match does: block the request, or record it. Defaults to `flag`. */
  action?: 'block' | 'flag';
}

/** Which tools a request may offer the model. */
export interface ToolPolicyConfig {
  /** The only tool names a request may carry; any other tool blocks it. Unset or empty allows every tool. */
  allowedNames?: string[];
  /**
   * Ignored: approval before a tool runs belongs to the agent loop.
   *
   * @deprecated Has never been read. It will be removed in 2.0.
   */
  requiresApproval?: string[];
}

/** Terms a response must not contain. */
export interface ModerationConfig {
  /** Turns moderation on. Off by default. */
  enabled?: boolean;
  /** Terms matched literally, ignoring case. */
  forbiddenTerms?: string[];
  /** What a match does: block the response, record it, or redact the term. Defaults to recording it. */
  onViolation?: 'block' | 'flag' | 'redact';
}

/** Data-loss prevention on output. */
export interface DLPConfig {
  /** Turns the checks on. On by default. */
  enabled?: boolean;
  /** Terms that must not leave, such as project code names. A match is recorded as a high finding. */
  proprietaryTerms?: string[];
  /** Redacts database connection strings. On by default. */
  connectionStrings?: boolean;
}

/** Topics a response must stay out of, matched as text, ignoring case. */
export interface TopicGuardrailConfig {
  /** The topics. */
  forbiddenTopics?: string[];
  /** What a match does: block the response, or record it. Defaults to recording it. */
  onViolation?: 'block' | 'flag';
}

/**
 * A cheap grounding check on output: the share of the response's longer words that also appear in
 * the context. A low share is recorded as a medium finding; it never blocks.
 */
export interface GroundingConfig {
  /** Turns the check on. Off by default. */
  enabled?: boolean;
  /** The context the response should draw from. */
  context?: string[];
  /** Smallest acceptable share, from 0 to 1. Defaults to 0.1. */
  minOverlapRatio?: number;
}

/** Guardrails for input and output, from a preset, a level, or detailed settings. */
export interface SecurityConfig {
  /** A preset tuned for a kind of deployment. */
  preset?: SecurityPreset;
  /** A protection level. */
  level?: SecurityLevel;
  /** Input guardrails: length, injection, PII, secrets, URLs, and tool policy. */
  input?: {
    /** Longest the request's text may be, in characters; longer blocks it. */
    maxContentLength?: number;
    /** Prompt-injection detection, from the `standard` level up. */
    injectionDetection?: InjectionDetectionConfig;
    /** Personal data detection, from the `standard` level up. */
    pii?: PIIConfig;
    /** Credential detection. */
    secrets?: SecretDetectionConfig;
    /** Risky URL detection. */
    urls?: UrlRiskConfig;
    /** Which tools a request may carry. */
    tools?: ToolPolicyConfig;
  };
  /** Output guardrails: length, PII redaction, moderation, DLP, topics, and grounding. */
  output?: {
    /** Longest the response may be, in characters; longer is cut, and the cut recorded. */
    maxContentLength?: number;
    /** Redacts secrets and personal data from the response and its tool-call arguments. On by default. */
    piiRedaction?: boolean;
    /** Forbidden terms. */
    moderation?: ModerationConfig;
    /** Connection strings and proprietary terms. */
    dlp?: DLPConfig;
    /** Forbidden topics. */
    topics?: TopicGuardrailConfig;
    /** Word overlap with a context. */
    grounding?: GroundingConfig;
  };
}

/** One thing a guardrail found. */
export interface SecurityFinding {
  /** Which guardrail found it. */
  type:
    | 'schema'
    | 'prompt-injection'
    | 'pii'
    | 'content-length'
    | 'secret'
    | 'url-risk'
    | 'tool-policy'
    | 'moderation'
    | 'dlp'
    | 'topic'
    | 'grounding';
  /** How serious it is. */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** What was found. */
  message: string;
  /** Where it was found, such as a message index. */
  path?: string;
  /** The matched text, redacted unless the finding was configured to keep it. */
  value?: string;
  /** Guardrail-specific details. */
  metadata?: Record<string, unknown>;
}

/** The outcome of running guardrails on a value. */
export interface SecurityResult<T> {
  /** False when a guardrail blocked the value. */
  ok: boolean;
  /** The value after masking and redaction. */
  value: T;
  /** Everything found. */
  findings: SecurityFinding[];
  /** Guardrails that ran. */
  guardrailsApplied: string[];
}
