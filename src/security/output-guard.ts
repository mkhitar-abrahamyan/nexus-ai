import type { NexusResponse } from '../types/response.js';
import type { SecurityConfig, SecurityFinding, SecurityResult } from '../types/security.js';

const OUTPUT_SECRET_PATTERNS: Array<{ pattern: RegExp; label: string; severity: SecurityFinding['severity'] }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'private key', severity: 'critical' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws access key', severity: 'critical' },
  { pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: 'payment secret key', severity: 'critical' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, label: 'github token', severity: 'critical' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, label: 'slack token', severity: 'critical' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'google api key', severity: 'critical' },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, label: 'jwt token', severity: 'high' },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, label: 'email address', severity: 'high' },
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, label: 'possible credit card', severity: 'high' },
  { pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi, label: 'api key assignment', severity: 'critical' },
];

const CONNECTION_STRING_PATTERN = /\b(?:postgres|postgresql|mysql|mongodb|redis|mssql):\/\/[^\s'"<>]+/gi;

export class OutputGuard {
  protect(response: NexusResponse, config: SecurityConfig = {}): SecurityResult<NexusResponse> {
    const findings: SecurityFinding[] = [];
    const guardrailsApplied: string[] = [];
    let content = response.content;

    if (config.output?.maxContentLength && content.length > config.output.maxContentLength) {
      findings.push({
        type: 'content-length',
        severity: 'medium',
        message: `Output exceeded maxContentLength ${config.output.maxContentLength}`,
        path: 'response.content',
      });
      content = content.slice(0, config.output.maxContentLength);
      guardrailsApplied.push('output-length-limit');
    }

    const shouldRedact = config.output?.piiRedaction !== false;
    if (shouldRedact) {
      for (const { pattern, label, severity } of OUTPUT_SECRET_PATTERNS) {
        content = content.replace(pattern, (value) => {
          findings.push({
            type: 'pii',
            severity,
            message: `Redacted output ${label}`,
            path: 'response.content',
            value,
          });
          return '[REDACTED]';
        });
      }
      guardrailsApplied.push('output-pii-redaction');
    }

    if (config.output?.dlp?.enabled !== false) {
      if (config.output?.dlp?.connectionStrings !== false) {
        content = content.replace(CONNECTION_STRING_PATTERN, (value) => {
          findings.push({
            type: 'dlp',
            severity: 'critical',
            message: 'Redacted output database connection string',
            path: 'response.content',
            value,
          });
          return '[REDACTED_CONNECTION_STRING]';
        });
      }

      for (const term of config.output?.dlp?.proprietaryTerms || []) {
        if (content.toLowerCase().includes(term.toLowerCase())) {
          findings.push({
            type: 'dlp',
            severity: 'high',
            message: `Output contains proprietary term: ${term}`,
            path: 'response.content',
            value: term,
          });
        }
      }
      guardrailsApplied.push('output-dlp-check');
    }

    const moderation = config.output?.moderation;
    if (moderation?.enabled) {
      for (const term of moderation.forbiddenTerms || []) {
        const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        content = content.replace(pattern, (value) => {
          findings.push({
            type: 'moderation',
            severity: moderation.onViolation === 'block' ? 'critical' : 'high',
            message: `Output moderation matched forbidden term: ${term}`,
            path: 'response.content',
            value,
          });
          return moderation.onViolation === 'redact' ? '[REDACTED]' : value;
        });
      }
      guardrailsApplied.push('output-moderation');
    }

    const topics = config.output?.topics;
    if (topics?.forbiddenTopics?.length) {
      for (const topic of topics.forbiddenTopics) {
        if (content.toLowerCase().includes(topic.toLowerCase())) {
          findings.push({
            type: 'topic',
            severity: topics.onViolation === 'block' ? 'critical' : 'high',
            message: `Output entered forbidden topic: ${topic}`,
            path: 'response.content',
            value: topic,
          });
        }
      }
      guardrailsApplied.push('output-topic-guardrail');
    }

    const grounding = config.output?.grounding;
    if (grounding?.enabled && grounding.context?.length) {
      const overlap = this.calculateOverlap(content, grounding.context.join('\n'));
      const minOverlapRatio = grounding.minOverlapRatio || 0.1;
      if (overlap < minOverlapRatio) {
        findings.push({
          type: 'grounding',
          severity: 'medium',
          message: `Output grounding overlap ${overlap.toFixed(2)} is below required ${minOverlapRatio}`,
          path: 'response.content',
          metadata: { overlap, minOverlapRatio },
        });
      }
      guardrailsApplied.push('output-grounding-check');
    }

    return {
      ok: true,
      value: {
        ...response,
        content,
        meta: {
          ...response.meta,
          guardrailsApplied: [...response.meta.guardrailsApplied, ...guardrailsApplied],
        },
      },
      findings,
      guardrailsApplied,
    };
  }

  private calculateOverlap(output: string, context: string): number {
    const outputTerms = new Set(output.toLowerCase().split(/\W+/).filter((term) => term.length > 4));
    const contextTerms = new Set(context.toLowerCase().split(/\W+/).filter((term) => term.length > 4));
    if (outputTerms.size === 0) return 1;

    let matches = 0;
    outputTerms.forEach((term) => {
      if (contextTerms.has(term)) matches += 1;
    });

    return matches / outputTerms.size;
  }
}
