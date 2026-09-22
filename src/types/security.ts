/** How much protection a client applies, from none to maximal. */
export type SecurityLevel = 'off' | 'basic' | 'standard' | 'strict' | 'paranoid';

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
  /** How eagerly patterns match, from 0 to 1. */
  sensitivity?: number;
  /** What a detection does: block the request, record it, or neutralize the text. */
  onDetection?: 'block' | 'flag' | 'transform';
  /** Extra patterns to treat as injection. */
  customPatterns?: RegExp[];
  /** Similarity-based detection against example attacks, through an embedder. */
  semantic?: {
    enabled?: boolean;
    threshold?: number;
    examples?: string[];
  };
}

/** Detection of personal data in input. */
export interface PIIConfig {
  /** Turns detection on. */
  enabled?: boolean;
  /** Kinds of data to detect. */
  detect?: PIIType[];
  /** What a match does: mask it, remove it, block the request, or record it. */
  action?: 'mask' | 'remove' | 'block' | 'flag';
  /** Character used for masking. */
  maskChar?: string;
  /** Keeps the data's shape when masking, such as the last four digits. */
  preserveFormat?: boolean;
}

export interface SecretDetectionConfig {
  enabled?: boolean;
  action?: 'block' | 'mask' | 'flag';
}

export interface UrlRiskConfig {
  enabled?: boolean;
  action?: 'block' | 'flag';
}

export interface ToolPolicyConfig {
  allowedNames?: string[];
  requiresApproval?: string[];
}

export interface ModerationConfig {
  enabled?: boolean;
  forbiddenTerms?: string[];
  onViolation?: 'block' | 'flag' | 'redact';
}

export interface DLPConfig {
  enabled?: boolean;
  proprietaryTerms?: string[];
  connectionStrings?: boolean;
}

export interface TopicGuardrailConfig {
  forbiddenTopics?: string[];
  onViolation?: 'block' | 'flag';
}

export interface GroundingConfig {
  enabled?: boolean;
  context?: string[];
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
    maxContentLength?: number;
    injectionDetection?: InjectionDetectionConfig;
    pii?: PIIConfig;
    secrets?: SecretDetectionConfig;
    urls?: UrlRiskConfig;
    tools?: ToolPolicyConfig;
  };
  /** Output guardrails: length, PII redaction, moderation, DLP, topics, and grounding. */
  output?: {
    maxContentLength?: number;
    piiRedaction?: boolean;
    moderation?: ModerationConfig;
    dlp?: DLPConfig;
    topics?: TopicGuardrailConfig;
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
