import type { AuditLogConfig, AuditLogEvent } from '../types/config.js';
import { redactSensitiveText } from '../security/output-guard.js';

export class AuditLogger {
  constructor(private config?: AuditLogConfig) {}

  async log(event: AuditLogEvent): Promise<void> {
    if (!this.config?.enabled) return;
    if (this.config.includeSensitiveData && !this.config.sink) {
      throw new Error('auditLog.includeSensitiveData requires an explicit access-controlled sink');
    }

    const timestampedEvent: AuditLogEvent = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    };
    const safeEvent = this.config.includeSensitiveData
      ? timestampedEvent
      : (sanitizeAuditValue(timestampedEvent) as AuditLogEvent);

    if (this.config.sink) {
      await this.config.sink(safeEvent);
      return;
    }

    console.info('[nexus-ai-pro:audit]', JSON.stringify(safeEvent));
  }
}

function sanitizeAuditValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item, undefined, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeAuditValue(childValue, childKey, seen)]),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return (
    normalized === 'value' ||
    /(?:secret|password|credential|apikey|token)$/.test(normalized) ||
    /^(?:authorization|proxyauthorization|cookie|setcookie)$/.test(normalized)
  );
}
