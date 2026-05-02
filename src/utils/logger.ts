export class Logger {
  constructor(private debug: boolean = false) {}

  info(msg: string, data?: Record<string, unknown>): void {
    if (this.debug) {
      console.log(`[nexus-ai-pro] ${msg}`, data ? JSON.stringify(data) : '');
    }
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    console.warn(`[nexus-ai-pro] WARN: ${msg}`, data ? JSON.stringify(data) : '');
  }

  error(msg: string, err?: unknown): void {
    console.error(`[nexus-ai-pro] ERROR: ${msg}`, err instanceof Error ? err.message : err);
  }
}
