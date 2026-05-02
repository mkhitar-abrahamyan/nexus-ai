import type { SecurityConfig } from '../types/security.js';

export type GuardrailPolicyName =
  | 'owasp-llm'
  | 'pii-safe'
  | 'rag-grounded'
  | 'tool-safe'
  | 'enterprise-strict';

export const GUARDRAIL_POLICIES: Record<GuardrailPolicyName, SecurityConfig> = {
  'owasp-llm': {
    level: 'strict',
    input: {
      injectionDetection: { enabled: true, onDetection: 'block' },
      secrets: { enabled: true, action: 'block' },
      urls: { enabled: true, action: 'flag' },
    },
    output: {
      piiRedaction: true,
      dlp: { enabled: true, connectionStrings: true },
    },
  },
  'pii-safe': {
    level: 'strict',
    input: {
      pii: { enabled: true, action: 'mask', preserveFormat: true },
      secrets: { enabled: true, action: 'block' },
    },
    output: { piiRedaction: true },
  },
  'rag-grounded': {
    level: 'standard',
    output: {
      grounding: {
        enabled: true,
        minOverlapRatio: 0.12,
      },
    },
  },
  'tool-safe': {
    level: 'strict',
    input: {
      injectionDetection: { enabled: true, onDetection: 'block' },
      tools: { allowedNames: [] },
    },
  },
  'enterprise-strict': {
    preset: 'enterprise',
    level: 'strict',
    input: {
      injectionDetection: { enabled: true, onDetection: 'block' },
      pii: { enabled: true, action: 'mask', preserveFormat: true },
      secrets: { enabled: true, action: 'block' },
      urls: { enabled: true, action: 'block' },
    },
    output: {
      piiRedaction: true,
      dlp: { enabled: true, connectionStrings: true },
    },
  },
};

export function guardrailPolicy(name: GuardrailPolicyName, overrides: SecurityConfig = {}): SecurityConfig {
  const base = GUARDRAIL_POLICIES[name];
  return {
    ...base,
    ...overrides,
    input: { ...base.input, ...overrides.input },
    output: { ...base.output, ...overrides.output },
  };
}
