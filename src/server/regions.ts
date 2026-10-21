/**
 * Agent servers across regions: a gateway in front of one agent server per region that sends each
 * request to the region its tenant and its data require, and fails over only to a region the tenant
 * may reach.
 */
import { ResidencyError } from '../residency/errors.js';
import type { ResidencyDecision, ResidencyPolicy } from '../types/residency.js';

/** One region's agent server: its base URL, or a handler in this process, such as `server.handle`. */
export interface RegionTarget {
  /** The server's base URL, such as `https://agents.eu-west.example.com`. */
  url?: string;
  /** A handler in this process instead, given every request as the server would receive it. */
  handle?: (request: Request) => Promise<Response>;
}

/** How a gateway checks each region. */
export interface RegionHealthOptions {
  /** How often `start()` checks every region, in milliseconds. Defaults to 10 seconds. */
  everyMs?: number;
  /** How long a check may take before it counts as a failure, in milliseconds. Defaults to 2 seconds. */
  timeoutMs?: number;
  /** Failures in a row, of checks and of forwarded requests, before a region is down. Defaults to 1. */
  failuresToDown?: number;
  /** The path checked. Defaults to `/health`, which a draining server answers with 503. */
  path?: string;
}

/** Options for `regionalGateway()`. */
export interface RegionalGatewayOptions {
  /** Each region's agent server, by region. Its threads and runs carry the region in their ids. */
  regions: Readonly<Record<string, RegionTarget>>;
  /** Which regions each tenant may reach. */
  residency: ResidencyPolicy;
  /**
   * The tenant a request is for, such as from a verified token. A request with none follows the
   * policy's `untenanted` rule.
   */
  tenantOf: (request: Request) => string | undefined | Promise<string | undefined>;
  /** How each region is checked. */
  health?: RegionHealthOptions;
  /** Replaces the global `fetch` for regions given by URL. */
  fetch?: typeof globalThis.fetch;
  /**
   * How `GET /threads` and `GET /runs` are answered: `merged`, the default, asks every region the
   * tenant may reach and merges their answers, newest first; `home` asks the home region alone, as
   * before 2.18.
   */
  lists?: 'merged' | 'home';
  /** Hears each failure to reach a region. */
  onError?: (error: unknown, region: string) => void;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** Where a region stands, as the gateway sees it. */
export interface RegionHealth {
  /** Whether new work is sent to it. */
  up: boolean;
  /** Failures in a row. */
  failures: number;
  /** ISO-8601 time it was last checked or reached. */
  checkedAt?: string;
  /** Why it is down, when it is. */
  reason?: string;
  /** True when an operator marked it, which only an operator undoes. */
  manual?: boolean;
}

/** A gateway in front of an agent server per region. */
export interface RegionalGateway {
  /** Answers one request: forwarded to a region, or refused. */
  handle(request: Request): Promise<Response>;
  /** Checks every region now, and returns where each stands. */
  check(): Promise<Record<string, RegionHealth>>;
  /** Where each region stands. */
  status(): Record<string, RegionHealth>;
  /** Takes a region out, as an operator does before maintenance, until `markUp()`. */
  markDown(region: string, reason?: string): void;
  /** Puts a region back, clearing its failures. */
  markUp(region: string): void;
  /** Checks every region on a timer until `stop()`. */
  start(): void;
  /** Stops `start()`. */
  stop(): void;
}

/** The id of a thread or run a region's server created, which starts with the region. */
const REGIONAL_ID = /^([A-Za-z0-9_.-]+)~(?:thread|run)-/;
/** The lists of a tenant's threads and runs, which the gateway gathers from every region. */
const LIST = /\/(threads|runs)\/?$/;

/** A region a merged list could not ask, and why. */
export interface RegionListGap {
  /** The region. */
  region: string;
  /** Why it is missing: down, unreachable, or what it answered. */
  reason: string;
}

/**
 * A gateway in front of one agent server per region. A request for a thread or a run, whose id names
 * the region that holds its data, goes to that region only: refused with a 403 when the tenant may not
 * reach it, and answered 503 while the region is down, since its data is there and nowhere else. A
 * request for new work goes to the tenant's home region, the first region it may reach, and, when that
 * is down or does not answer, to the next one it may reach, never to another. A tenant that may reach
 * no region the gateway serves is refused with a 403 naming the rule. A list of the tenant's threads or
 * runs is gathered from every region it may reach, newest first, naming any that could not answer.
 *
 * ```ts
 * const gateway = regionalGateway({
 *   regions: { 'eu-west': { url: 'https://eu-west.agents.internal' }, 'us-east': { url: 'https://us-east.agents.internal' } },
 *   residency: policy,
 *   tenantOf: (request) => verify(request).tenantId,
 * });
 * gateway.start();
 * serve({ fetch: gateway.handle });
 * ```
 */
export function regionalGateway(options: RegionalGatewayOptions): RegionalGateway {
  const now = options.now ?? (() => new Date());
  const failuresToDown = Math.max(1, options.health?.failuresToDown ?? 1);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const state = new Map<string, RegionHealth>(
    Object.keys(options.regions).map((region) => [region, { up: true, failures: 0 }]),
  );
  let timer: ReturnType<typeof setInterval> | undefined;

  const failed = (region: string, reason: string) => {
    const current = state.get(region) ?? { up: true, failures: 0 };
    if (current.manual) return;
    const failures = current.failures + 1;
    state.set(region, {
      up: failures < failuresToDown && current.up,
      failures,
      checkedAt: now().toISOString(),
      ...(failures >= failuresToDown ? { reason } : {}),
    });
  };
  const succeeded = (region: string) => {
    const current = state.get(region);
    if (current?.manual) return;
    state.set(region, { up: true, failures: 0, checkedAt: now().toISOString() });
  };
  const isUp = (region: string) => state.get(region)?.up !== false;

  const send = async (region: string, request: Request, body: ArrayBuffer | undefined): Promise<Response> => {
    const target = options.regions[region] as RegionTarget;
    const incoming = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    const init: RequestInit = { method: request.method, headers, ...(body ? { body } : {}), signal: request.signal };
    const response = target.handle
      ? await target.handle(new Request(request.url, init))
      : await fetchImpl(`${(target.url ?? '').replace(/\/+$/, '')}${incoming.pathname}${incoming.search}`, init);
    // The region that answered, for the client and for whoever reads the logs.
    const answered = new Headers(response.headers);
    answered.set('x-nexus-region', region);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: answered });
  };

  const refuse = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
    });

  const residencyRefusal = (region: string | undefined, decision: ResidencyDecision, detail?: string) =>
    refuse(
      403,
      'RESIDENCY_DENIED',
      new ResidencyError({ kind: 'region', name: region ?? 'any', ...(region ? { region } : {}) }, decision, detail)
        .message,
    );

  /**
   * A list gathered from every region the tenant may reach: each asked for the same page, the answers
   * merged newest first and cut to the limit, with the regions that answered and those that could not.
   */
  const merged = async (kind: 'threads' | 'runs', request: Request, allowed: string[]): Promise<Response> => {
    const gaps: RegionListGap[] = allowed
      .filter((region) => !isUp(region))
      .map((region) => ({ region, reason: 'down' }));
    const answers = await Promise.all(
      allowed.filter(isUp).map(async (region) => {
        try {
          const response = await send(region, request, undefined);
          if (!response.ok) {
            if (response.status === 502 || response.status === 504) failed(region, `answered ${response.status}`);
            return { region, response };
          }
          succeeded(region);
          const body = (await response.json()) as Record<string, unknown>;
          return { region, items: Array.isArray(body[kind]) ? (body[kind] as Array<Record<string, unknown>>) : [] };
        } catch (error) {
          options.onError?.(error, region);
          failed(region, error instanceof Error ? error.message : String(error));
          return { region, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const answered = answers.filter((answer) => answer.items).map((answer) => answer.region);
    for (const answer of answers) {
      if (answer.response) gaps.push({ region: answer.region, reason: `answered ${answer.response.status}` });
      else if (answer.error !== undefined) gaps.push({ region: answer.region, reason: answer.error });
    }
    if (answered.length === 0) {
      // A refusal every region gives, such as a missing credential, is the answer; otherwise none could.
      const refused = answers.find((answer) => answer.response && answer.response.status < 500)?.response;
      if (refused) return refused;
      return refuse(503, 'REGION_DOWN', `No region this list may reach answered: ${allowed.join(', ')}`, {
        'retry-after': String(Math.ceil((options.health?.everyMs ?? 10_000) / 1000)),
      });
    }
    const requested = Number(new URL(request.url).searchParams.get('limit'));
    const limit = Number.isInteger(requested) && requested > 0 ? requested : 50;
    const items = answers
      .flatMap((answer) => answer.items ?? [])
      .sort((a, b) => {
        const time = String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''));
        return time || String(a.id ?? '').localeCompare(String(b.id ?? ''));
      })
      .slice(0, limit);
    return new Response(
      JSON.stringify({ [kind]: items, regions: answered, ...(gaps.length ? { incomplete: gaps } : {}) }),
      {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-nexus-region': answered.join(',') },
      },
    );
  };

  const gateway: RegionalGateway = {
    async handle(request) {
      const decision = await options.residency.regionsFor(await options.tenantOf(request));
      const path = new URL(request.url).pathname;
      const sticky = path
        .split('/')
        .map((segment) => REGIONAL_ID.exec(decodeURIComponent(segment))?.[1])
        .find((region): region is string => region !== undefined);

      if (sticky !== undefined) {
        if (!(sticky in options.regions)) return refuse(404, 'UNKNOWN_REGION', `No region "${sticky}" is served here`);
        if (!options.residency.allows(sticky, decision)) return residencyRefusal(sticky, decision);
        if (!isUp(sticky)) {
          return refuse(
            503,
            'REGION_DOWN',
            `Region ${sticky} is down, and this thread's data is kept there and nowhere else`,
            { 'retry-after': String(Math.ceil((options.health?.everyMs ?? 10_000) / 1000)) },
          );
        }
        try {
          const response = await send(sticky, request, await bodyOf(request));
          if (response.status !== 502 && response.status !== 504) succeeded(sticky);
          else failed(sticky, `answered ${response.status}`);
          return response;
        } catch (error) {
          options.onError?.(error, sticky);
          failed(sticky, error instanceof Error ? error.message : String(error));
          return refuse(502, 'REGION_UNREACHABLE', `Region ${sticky} could not be reached`);
        }
      }

      const allowed = (decision.regions ?? Object.keys(options.regions)).filter((region) => region in options.regions);
      if (allowed.length === 0) return residencyRefusal(undefined, decision, 'no region it may reach is served here');
      const list = request.method === 'GET' ? LIST.exec(path)?.[1] : undefined;
      if (list && (options.lists ?? 'merged') === 'merged') return merged(list as 'threads' | 'runs', request, allowed);
      const candidates = allowed.filter(isUp);
      if (candidates.length === 0) {
        return refuse(503, 'REGION_DOWN', `Every region this request may reach is down: ${allowed.join(', ')}`, {
          'retry-after': String(Math.ceil((options.health?.everyMs ?? 10_000) / 1000)),
        });
      }
      const body = await bodyOf(request);
      let last: Response | undefined;
      for (const region of candidates) {
        try {
          const response = await send(region, request, body);
          // A region that did not answer is failed over from; any answer it gave is its answer.
          if (response.status === 502 || response.status === 504) {
            failed(region, `answered ${response.status}`);
            last = response;
            continue;
          }
          succeeded(region);
          return response;
        } catch (error) {
          options.onError?.(error, region);
          failed(region, error instanceof Error ? error.message : String(error));
        }
      }
      return (
        last ?? refuse(502, 'REGION_UNREACHABLE', `No region this request may reach answered: ${candidates.join(', ')}`)
      );
    },

    async check() {
      await Promise.all(
        Object.entries(options.regions).map(async ([region, target]) => {
          if (state.get(region)?.manual) return;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), options.health?.timeoutMs ?? 2_000);
          try {
            const path = options.health?.path ?? '/health';
            const response = target.handle
              ? await target.handle(new Request(`http://${region}.region${path}`, { signal: controller.signal }))
              : await fetchImpl(`${(target.url ?? '').replace(/\/+$/, '')}${path}`, { signal: controller.signal });
            if (response.ok) succeeded(region);
            else failed(region, `health answered ${response.status}`);
          } catch (error) {
            options.onError?.(error, region);
            failed(region, error instanceof Error ? error.message : String(error));
          } finally {
            clearTimeout(timeout);
          }
        }),
      );
      return gateway.status();
    },

    status() {
      return Object.fromEntries([...state.entries()].map(([region, health]) => [region, { ...health }]));
    },

    markDown(region, reason = 'marked down') {
      state.set(region, {
        up: false,
        failures: state.get(region)?.failures ?? 0,
        reason,
        manual: true,
        checkedAt: now().toISOString(),
      });
    },

    markUp(region) {
      state.set(region, { up: true, failures: 0, checkedAt: now().toISOString() });
    },

    start() {
      if (timer) return;
      timer = setInterval(() => void gateway.check(), options.health?.everyMs ?? 10_000);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return gateway;
}

/** A request's body, read once so it can be sent to a second region. */
async function bodyOf(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const body = await request.arrayBuffer();
  return body.byteLength > 0 ? body : undefined;
}
