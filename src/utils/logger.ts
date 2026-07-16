import type { LoggerConfig, LogEvent, LogLevel } from '../types/config.js';

export class Logger {
  constructor(
    private debug: boolean = false,
    private config: LoggerConfig = {},
  ) {}

  info(msg: string, data?: Record<string, unknown>): void {
    this.emit('info', msg, data);
    if (this.shouldWriteConsole('info')) {
      console.log(`[nexus-ai-pro] ${msg}`, data ? JSON.stringify(data) : '');
    }
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit('warn', msg, data);
    if (this.shouldWriteConsole('warn')) {
      console.warn(`[nexus-ai-pro] WARN: ${msg}`, data ? JSON.stringify(data) : '');
    }
  }

  error(msg: string, err?: unknown): void {
    this.emit('error', msg, undefined, err);
    if (this.shouldWriteConsole('error')) {
      console.error(`[nexus-ai-pro] ERROR: ${msg}`, err instanceof Error ? err.message : err);
    }
  }

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>, error?: unknown): void {
    if (!this.config.sink) return;

    const event: LogEvent = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(data ? { data } : {}),
      ...(error !== undefined ? { error: serializeError(error) } : {}),
    };

    try {
      const result = this.config.sink(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch((sinkError) => {
          if (this.config.console !== false) {
            console.warn(
              '[nexus-ai-pro] WARN: logger sink failed',
              sinkError instanceof Error ? sinkError.message : sinkError,
            );
          }
        });
      }
    } catch (sinkError) {
      if (this.config.console !== false) {
        console.warn(
          '[nexus-ai-pro] WARN: logger sink failed',
          sinkError instanceof Error ? sinkError.message : sinkError,
        );
      }
    }
  }

  private shouldWriteConsole(level: LogLevel): boolean {
    if (this.config.console !== undefined) return this.config.console;
    return level === 'info' ? this.debug : true;
  }
}

function serializeError(error: unknown): LogEvent['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}
