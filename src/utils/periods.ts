import type { BudgetPeriod } from '../types/lifecycle.js';

/** The start of the period `at` falls in, as epoch milliseconds, in UTC. */
export function periodStart(period: BudgetPeriod, at: Date): number {
  if (typeof period === 'object') return Math.floor(at.getTime() / period.windowMs) * period.windowMs;
  const date = new Date(at.getTime());
  if (period === 'hour')
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
  if (period === 'day') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === 'week') {
    // Weeks start on Monday.
    const day = (date.getUTCDay() + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** When the period `at` falls in ends, as epoch milliseconds. */
export function periodEnd(period: BudgetPeriod, at: Date): number {
  const start = periodStart(period, at);
  if (typeof period === 'object') return start + period.windowMs;
  if (period === 'hour') return start + 3_600_000;
  if (period === 'day') return start + 86_400_000;
  if (period === 'week') return start + 7 * 86_400_000;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** The period in words, for an error message. */
export function describePeriod(period: BudgetPeriod): string {
  return typeof period === 'object' ? `${period.windowMs / 1000}s window` : period;
}
