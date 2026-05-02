import type { AuditLogConfig, AuditLogEvent } from '../types/config.js';

export class AuditLogger {
  constructor(private config?: AuditLogConfig) {}

  async log(event: AuditLogEvent): Promise<void> {
    if (!this.config?.enabled) return;

    const safeEvent: AuditLogEvent = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    if (this.config.sink) {
      await this.config.sink(safeEvent);
      return;
    }

    console.info('[nexus-ai-pro:audit]', JSON.stringify(safeEvent));
  }
}
