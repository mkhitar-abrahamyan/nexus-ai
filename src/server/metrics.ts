/**
 * The counters and histograms one replica keeps about the runs it executes, in Prometheus text.
 *
 * Written rather than imported, like the router: the server needs three metric kinds and a text
 * format, which is far smaller than any client library, and nothing here runs unless `/metrics` is
 * scraped.
 */

/** Seconds, from a tenth of a second to half an hour: the range an assistant run spans. */
const SECONDS_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];

type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
}

interface Histogram {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

/** A replica's run counters and latency histograms. */
export class ServerMetrics {
  private readonly counters = new Map<string, Map<string, Series>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();

  /** Adds to a counter. */
  count(name: string, labels: Labels, by = 1): void {
    const series = seriesOf(this.counters, name);
    const key = keyOf(labels);
    const current = series.get(key);
    if (current) current.value += by;
    else series.set(key, { labels, value: by });
  }

  /** Records a duration, in seconds, in a histogram. */
  observe(name: string, labels: Labels, seconds: number): void {
    const series = seriesOf(this.histograms, name);
    const key = keyOf(labels);
    let histogram = series.get(key);
    if (!histogram) {
      histogram = { labels, counts: SECONDS_BUCKETS.map(() => 0), sum: 0, count: 0 };
      series.set(key, histogram);
    }
    for (let index = 0; index < SECONDS_BUCKETS.length; index += 1) {
      if (seconds <= (SECONDS_BUCKETS[index] as number)) histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
    }
    histogram.sum += seconds;
    histogram.count += 1;
  }

  /** A counter's value for one set of labels, for tests and reports. */
  value(name: string, labels: Labels): number {
    return this.counters.get(name)?.get(keyOf(labels))?.value ?? 0;
  }

  /** Appends every counter and histogram to `lines`, with the help text given per name. */
  render(lines: string[], help: Record<string, string>): void {
    for (const [name, series] of this.counters) {
      header(lines, name, 'counter', help[name]);
      for (const item of series.values()) lines.push(`${name}${labelText(item.labels)} ${item.value}`);
    }
    for (const [name, series] of this.histograms) {
      header(lines, name, 'histogram', help[name]);
      for (const item of series.values()) {
        SECONDS_BUCKETS.forEach((bound, index) => {
          lines.push(`${name}_bucket${labelText({ ...item.labels, le: String(bound) })} ${item.counts[index]}`);
        });
        lines.push(`${name}_bucket${labelText({ ...item.labels, le: '+Inf' })} ${item.count}`);
        lines.push(`${name}_sum${labelText(item.labels)} ${round(item.sum)}`);
        lines.push(`${name}_count${labelText(item.labels)} ${item.count}`);
      }
    }
  }
}

/** Appends one gauge with its header. */
export function gauge(lines: string[], name: string, help: string, value: number, labels: Labels = {}): void {
  header(lines, name, 'gauge', help);
  lines.push(`${name}${labelText(labels)} ${round(value)}`);
}

function header(lines: string[], name: string, type: string, help?: string): void {
  if (help) lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function seriesOf<T>(map: Map<string, Map<string, T>>, name: string): Map<string, T> {
  let series = map.get(name);
  if (!series) {
    series = new Map();
    map.set(name, series);
  }
  return series;
}

function keyOf(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join('\u0000');
}

function labelText(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
