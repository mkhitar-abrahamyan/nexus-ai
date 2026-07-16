import type { NexusResponse } from '../types/response.js';
import type { SecurityConfig, SecurityFinding, SecurityResult } from '../types/security.js';

const OUTPUT_SECRET_PATTERNS: Array<{ pattern: RegExp; label: string; severity: SecurityFinding['severity'] }> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: 'private key',
    severity: 'critical',
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws access key', severity: 'critical' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: 'api token', severity: 'critical' },
  { pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: 'payment secret key', severity: 'critical' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, label: 'github token', severity: 'critical' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, label: 'slack token', severity: 'critical' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'google api key', severity: 'critical' },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, label: 'jwt token', severity: 'high' },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, label: 'email address', severity: 'high' },
  {
    pattern: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g,
    label: 'phone number',
    severity: 'high',
  },
  {
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    label: 'ip address',
    severity: 'high',
  },
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, label: 'possible credit card', severity: 'high' },
  {
    pattern:
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|token)\s*[:=]\s*(?:['"][^'"\r\n]+['"]|[^\s,;]{8,})/gi,
    label: 'secret assignment',
    severity: 'critical',
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/gi, label: 'bearer token', severity: 'critical' },
];

const CONNECTION_STRING_PATTERN = /\b(?:postgres|postgresql|mysql|mongodb|redis|mssql):\/\/[^\s'"<>]+/gi;

/**
 * Removes common credentials and personal data from diagnostic text.
 *
 * This helper intentionally does not report what matched, which makes it safe
 * for audit/error paths where echoing the original match would recreate the
 * leak that the output guard detected.
 */
export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const { pattern } of OUTPUT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted.replace(CONNECTION_STRING_PATTERN, '[REDACTED_CONNECTION_STRING]');
}

export class OutputGuard {
  protect(response: NexusResponse, config: SecurityConfig = {}): SecurityResult<NexusResponse> {
    const findings: SecurityFinding[] = [];
    const guardrailsApplied: string[] = [];
    const textTargets: OutputTextTarget[] = [
      { path: 'response.content', inspectionValue: response.content, value: response.content },
      ...(response.toolCalls || []).map((toolCall, index) => ({
        path: `response.toolCalls[${index}].function.arguments`,
        inspectionValue: toolCall.function.arguments,
        value: toolCall.function.arguments,
      })),
    ];
    const contentTarget = textTargets[0];
    let blocked = false;

    if (config.output?.maxContentLength && contentTarget.value.length > config.output.maxContentLength) {
      findings.push({
        type: 'content-length',
        severity: 'medium',
        message: `Output exceeded maxContentLength ${config.output.maxContentLength}`,
        path: 'response.content',
      });
      contentTarget.value = contentTarget.value.slice(0, config.output.maxContentLength);
      guardrailsApplied.push('output-length-limit');
    }

    const shouldRedact = config.output?.piiRedaction !== false;
    if (shouldRedact) {
      for (const { pattern, label, severity } of OUTPUT_SECRET_PATTERNS) {
        for (const target of textTargets) {
          target.value = target.value.replace(pattern, (value) => {
            findings.push({
              type: 'pii',
              severity,
              message: `Redacted output ${label}`,
              path: target.path,
              value,
            });
            return '[REDACTED]';
          });
        }
      }
      guardrailsApplied.push('output-pii-redaction');
    }

    if (config.output?.dlp?.enabled !== false) {
      if (config.output?.dlp?.connectionStrings !== false) {
        for (const target of textTargets) {
          target.value = target.value.replace(CONNECTION_STRING_PATTERN, (value) => {
            findings.push({
              type: 'dlp',
              severity: 'critical',
              message: 'Redacted output database connection string',
              path: target.path,
              value,
            });
            return '[REDACTED_CONNECTION_STRING]';
          });
        }
      }

      for (const term of config.output?.dlp?.proprietaryTerms || []) {
        for (const target of textTargets) {
          if (target.inspectionValue.toLowerCase().includes(term.toLowerCase())) {
            findings.push({
              type: 'dlp',
              severity: 'high',
              message: 'Output contains a configured proprietary term',
              path: target.path,
              value: term,
            });
          }
        }
      }
      guardrailsApplied.push('output-dlp-check');
    }

    const moderation = config.output?.moderation;
    if (moderation?.enabled) {
      for (const term of moderation.forbiddenTerms || []) {
        for (const target of textTargets) {
          const pattern = createLiteralPattern(term);
          const matches = target.inspectionValue.match(pattern) || [];
          for (const value of matches) {
            findings.push({
              type: 'moderation',
              severity: moderation.onViolation === 'block' ? 'critical' : 'high',
              message: 'Output moderation matched configured forbidden content',
              path: target.path,
              value,
            });
          }
          if (matches.length && moderation.onViolation === 'block') blocked = true;
          if (moderation.onViolation === 'redact')
            target.value = target.value.replace(createLiteralPattern(term), '[REDACTED]');
        }
      }
      guardrailsApplied.push('output-moderation');
    }

    const topics = config.output?.topics;
    if (topics?.forbiddenTopics?.length) {
      for (const topic of topics.forbiddenTopics) {
        for (const target of textTargets) {
          if (target.inspectionValue.toLowerCase().includes(topic.toLowerCase())) {
            findings.push({
              type: 'topic',
              severity: topics.onViolation === 'block' ? 'critical' : 'high',
              message: 'Output entered a configured forbidden topic',
              path: target.path,
              value: topic,
            });
            if (topics.onViolation === 'block') blocked = true;
          }
        }
      }
      guardrailsApplied.push('output-topic-guardrail');
    }

    const grounding = config.output?.grounding;
    if (grounding?.enabled && grounding.context?.length) {
      const overlap = this.calculateOverlap(contentTarget.value, grounding.context.join('\n'));
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

    // A caller inspecting a failed SecurityResult must not receive any output
    // text that contributed to the blocking decision. NexusAI will additionally
    // turn this result into a NexusSecurityError before returning or caching it.
    if (blocked) {
      for (const target of textTargets) target.value = '[BLOCKED_BY_OUTPUT_GUARD]';
    }

    const safeFindings = blocked
      ? findings.map((finding) => (finding.value === undefined ? finding : { ...finding, value: '[REDACTED]' }))
      : findings;

    return {
      ok: !blocked,
      value: {
        ...response,
        content: contentTarget.value,
        ...(response.toolCalls
          ? {
              toolCalls: response.toolCalls.map((toolCall, index) => ({
                ...toolCall,
                function: {
                  ...toolCall.function,
                  arguments: textTargets[index + 1].value,
                },
              })),
            }
          : {}),
        meta: {
          ...response.meta,
          guardrailsApplied: [...new Set([...response.meta.guardrailsApplied, ...guardrailsApplied])],
        },
      },
      findings: safeFindings,
      guardrailsApplied,
    };
  }

  private calculateOverlap(output: string, context: string): number {
    const outputTerms = new Set(
      output
        .toLowerCase()
        .split(/\W+/)
        .filter((term) => term.length > 4),
    );
    const contextTerms = new Set(
      context
        .toLowerCase()
        .split(/\W+/)
        .filter((term) => term.length > 4),
    );
    if (outputTerms.size === 0) return 1;

    let matches = 0;
    outputTerms.forEach((term) => {
      if (contextTerms.has(term)) matches += 1;
    });

    return matches / outputTerms.size;
  }
}

interface OutputTextTarget {
  path: string;
  inspectionValue: string;
  value: string;
}

function createLiteralPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}
