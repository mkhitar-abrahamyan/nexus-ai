import type { CompletionRequest, Message } from '../types/messages.js';
import type { SecurityConfig, SecurityFinding, SecurityResult } from '../types/security.js';

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string; severity: SecurityFinding['severity'] }> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: 'private key',
    severity: 'critical',
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws access key', severity: 'critical' },
  { pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: 'payment secret key', severity: 'critical' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, label: 'github token', severity: 'critical' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, label: 'slack token', severity: 'critical' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'google api key', severity: 'critical' },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, label: 'jwt token', severity: 'high' },
  {
    pattern: /(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    label: 'secret assignment',
    severity: 'critical',
  },
];

const SUSPICIOUS_URL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254)(?:[:/]|$)/gi,
    label: 'local or metadata URL',
  },
  { pattern: /https?:\/\/[^\s]*\.(?:onion)(?:[:/]|$)/gi, label: 'onion URL' },
  {
    pattern: /https?:\/\/[^\s]*(?:token|secret|password|apikey|api_key)=[^\s]+/gi,
    label: 'URL containing secret-like query',
  },
];

export class InputGuard {
  protect(request: CompletionRequest, config: SecurityConfig = {}): SecurityResult<CompletionRequest> {
    const findings: SecurityFinding[] = [];
    const guardrailsApplied: string[] = [];
    let safeRequest = request;

    const maxContentLength = config.input?.maxContentLength;
    if (maxContentLength) {
      const totalLength = request.messages.reduce(
        (sum, message) => sum + this.extractText(message).join('\n').length,
        0,
      );
      guardrailsApplied.push('input-length-check');
      if (totalLength > maxContentLength) {
        findings.push({
          type: 'content-length',
          severity: 'high',
          message: `Input exceeded maxContentLength ${maxContentLength}`,
          path: 'messages',
          metadata: { totalLength, maxContentLength },
        });
      }
    }

    if (config.input?.secrets?.enabled !== false) {
      const action = config.input?.secrets?.action || 'block';
      safeRequest = this.inspectAndMaybeMask(
        safeRequest,
        SECRET_PATTERNS,
        'secret',
        action,
        findings,
        guardrailsApplied,
      );
    }

    if (config.input?.urls?.enabled !== false) {
      guardrailsApplied.push('url-risk-detection');
      request.messages.forEach((message, index) => {
        for (const text of this.extractText(message)) {
          for (const { pattern, label } of SUSPICIOUS_URL_PATTERNS) {
            const matches = text.match(pattern) || [];
            for (const value of matches) {
              findings.push({
                type: 'url-risk',
                severity: 'high',
                message: `Suspicious URL detected: ${label}`,
                path: `messages.${index}.content`,
                value,
              });
            }
          }
        }
      });
    }

    if (config.input?.tools?.allowedNames?.length && request.tools?.length) {
      guardrailsApplied.push('tool-allowlist-check');
      const allowed = new Set(config.input.tools.allowedNames);
      request.tools.forEach((tool, index) => {
        if (!allowed.has(tool.name)) {
          findings.push({
            type: 'tool-policy',
            severity: 'critical',
            message: `Tool "${tool.name}" is not allowed by security policy`,
            path: `tools.${index}.name`,
            value: tool.name,
          });
        }
      });
    }

    return {
      ok: findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high').length === 0,
      value: safeRequest,
      findings,
      guardrailsApplied,
    };
  }

  private inspectAndMaybeMask(
    request: CompletionRequest,
    patterns: Array<{ pattern: RegExp; label: string; severity: SecurityFinding['severity'] }>,
    type: SecurityFinding['type'],
    action: 'block' | 'mask' | 'flag',
    findings: SecurityFinding[],
    guardrailsApplied: string[],
  ): CompletionRequest {
    guardrailsApplied.push('secret-detection');

    const maskText = (text: string, path: string): string => {
      let output = text;
      patterns.forEach(({ pattern, label, severity }) => {
        output = output.replace(pattern, (value) => {
          findings.push({ type, severity, message: `Detected ${label}`, path, value });
          return action === 'mask' ? '[REDACTED]' : value;
        });
      });
      return output;
    };

    if (action !== 'mask') return request;

    return {
      ...request,
      messages: request.messages.map((message, index) => ({
        ...message,
        content:
          typeof message.content === 'string'
            ? maskText(message.content, `messages.${index}.content`)
            : message.content.map((part) =>
                part.type === 'text' ? { ...part, text: maskText(part.text, `messages.${index}.content`) } : part,
              ),
      })),
    };
  }

  private extractText(message: Message): string[] {
    if (typeof message.content === 'string') return [message.content];
    return message.content.filter((part) => part.type === 'text').map((part) => part.text);
  }
}
