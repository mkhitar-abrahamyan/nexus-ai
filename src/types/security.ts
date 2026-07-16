export type SecurityLevel = 'off' | 'basic' | 'standard' | 'strict' | 'paranoid';

export type SecurityPreset = 'developer' | 'startup' | 'enterprise' | 'healthcare' | 'finance';

export type SecurityAction = 'allow' | 'block' | 'mask' | 'flag';

export type PIIType = 'email' | 'phone' | 'credit-card' | 'ip-address' | 'aws-key' | 'private-key';

export interface InjectionDetectionConfig {
  enabled?: boolean;
  sensitivity?: number;
  onDetection?: 'block' | 'flag' | 'transform';
  customPatterns?: RegExp[];
  semantic?: {
    enabled?: boolean;
    threshold?: number;
    examples?: string[];
  };
}

export interface PIIConfig {
  enabled?: boolean;
  detect?: PIIType[];
  action?: 'mask' | 'remove' | 'block' | 'flag';
  maskChar?: string;
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

export interface SecurityConfig {
  preset?: SecurityPreset;
  level?: SecurityLevel;
  input?: {
    maxContentLength?: number;
    injectionDetection?: InjectionDetectionConfig;
    pii?: PIIConfig;
    secrets?: SecretDetectionConfig;
    urls?: UrlRiskConfig;
    tools?: ToolPolicyConfig;
  };
  output?: {
    maxContentLength?: number;
    piiRedaction?: boolean;
    moderation?: ModerationConfig;
    dlp?: DLPConfig;
    topics?: TopicGuardrailConfig;
    grounding?: GroundingConfig;
  };
}

export interface SecurityFinding {
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
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  path?: string;
  value?: string;
  metadata?: Record<string, unknown>;
}

export interface SecurityResult<T> {
  ok: boolean;
  value: T;
  findings: SecurityFinding[];
  guardrailsApplied: string[];
}
