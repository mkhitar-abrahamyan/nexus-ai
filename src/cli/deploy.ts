import type { DeploymentRecord } from '../types/server.js';
import { CliUsageError, type Flags, numberFlag, type ParsedArgs, printTable, stringFlag, writeJson } from './args.js';

/** A deployment as `GET /deployments/:assistant` returns it, with each revision's runs since the last change. */
type DeploymentWithStats = DeploymentRecord & {
  stats?: Array<{ revision: string; runs: number; failed: number; errorRate: number; p95Ms?: number }>;
};

/**
 * `nexus deploy` reads and changes an agent server's deployments over HTTP, for a pipeline that rolls
 * out a new image and then moves traffic onto it:
 *
 *   nexus deploy status [assistant]
 *   nexus deploy canary <assistant> <revision> <percent>
 *   nexus deploy promote <assistant> <revision>
 *   nexus deploy rollback <assistant> [--to <revision>]
 *
 * `--url` (or `NEXUS_SERVER_URL`) names the server, and `--token` (or `NEXUS_SERVER_TOKEN`) is sent
 * as a bearer token. Changes take `--reason`, recorded in the deployment's history, and `--version`,
 * which refuses the change if someone else moved the deployment first.
 */
export async function runDeployCommand(
  subcommand: string | undefined,
  { positionals, flags }: ParsedArgs,
): Promise<void> {
  const server = serverOf(flags);
  const reason = stringFlag(flags, 'reason');
  const expectedVersion = numberFlag(flags, 'version');
  const change = async (assistant: string | undefined, body: Record<string, unknown>) => {
    if (!assistant) throw new CliUsageError(`nexus deploy ${subcommand} needs an assistant.`);
    const deployment = await server.request<DeploymentRecord>('POST', `/deployments/${encodeURIComponent(assistant)}`, {
      ...body,
      ...(reason ? { reason } : {}),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    if (flags.json === true) writeJson(deployment);
    else
      console.log(
        `${assistant}: version ${deployment.version}, live ${deployment.live}, ${splitText(deployment.traffic)}`,
      );
  };

  switch (subcommand) {
    case 'status': {
      const [assistant] = positionals;
      if (assistant) {
        const deployment = await server.request<DeploymentWithStats>(
          'GET',
          `/deployments/${encodeURIComponent(assistant)}`,
        );
        if (flags.json === true) return writeJson(deployment);
        console.log(`${deployment.assistant}: version ${deployment.version}, live ${deployment.live}`);
        console.log(`split: ${splitText(deployment.traffic)}`);
        if (deployment.stats?.length) {
          console.log('');
          printTable(
            deployment.stats.map((item) => ({
              revision: item.revision || '(none)',
              runs: String(item.runs),
              failed: String(item.failed),
              'error rate': `${(item.errorRate * 100).toFixed(1)}%`,
              p95: item.p95Ms === undefined ? '' : `${Math.round(item.p95Ms)}ms`,
            })),
            ['revision', 'runs', 'failed', 'error rate', 'p95'],
          );
        }
        if (deployment.history.length) {
          console.log('');
          printTable(
            deployment.history.slice(0, 10).map((entry) => ({
              version: String(entry.version),
              at: entry.at,
              action: entry.action,
              split: splitText(entry.traffic),
              by: entry.by ?? '',
              reason: entry.reason ?? '',
            })),
            ['version', 'at', 'action', 'split', 'by', 'reason'],
          );
        }
        return;
      }
      const { deployments } = await server.request<{ deployments: DeploymentRecord[] }>('GET', '/deployments');
      if (flags.json === true) return writeJson(deployments);
      printTable(
        deployments.map((deployment) => ({
          assistant: deployment.assistant,
          live: deployment.live,
          split: splitText(deployment.traffic),
          version: String(deployment.version),
          updated: deployment.version ? deployment.updatedAt : 'never',
        })),
        ['assistant', 'live', 'split', 'version', 'updated'],
      );
      return;
    }
    case 'canary': {
      const [assistant, revision, percent] = positionals;
      const share = Number(percent);
      if (!revision || !Number.isFinite(share) || share < 0 || share > 100) {
        throw new CliUsageError('Usage: nexus deploy canary <assistant> <revision> <percent from 0 to 100>');
      }
      return change(assistant, { action: 'canary', revision, weight: share / 100 });
    }
    case 'promote': {
      const [assistant, revision] = positionals;
      if (!revision) throw new CliUsageError('Usage: nexus deploy promote <assistant> <revision>');
      return change(assistant, { action: 'promote', revision });
    }
    case 'rollback': {
      const [assistant] = positionals;
      const to = stringFlag(flags, 'to');
      return change(assistant, { action: 'rollback', ...(to ? { to } : {}) });
    }
    default:
      throw new CliUsageError(
        `Unknown deploy command "${subcommand ?? ''}". Use status, canary, promote, or rollback.`,
      );
  }
}

function serverOf(flags: Flags) {
  const url = stringFlag(flags, 'url') ?? process.env.NEXUS_SERVER_URL;
  if (!url) throw new CliUsageError('nexus deploy needs the server: pass --url or set NEXUS_SERVER_URL.');
  const token = stringFlag(flags, 'token') ?? process.env.NEXUS_SERVER_TOKEN;
  const base = url.replace(/\/+$/, '');
  return {
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      if (!response.ok) {
        const error = (parsed as { error?: { code?: string; message?: string } }).error;
        throw new Error(`${response.status} ${error?.code ?? response.statusText}: ${error?.message ?? text}`);
      }
      return parsed as T;
    },
  };
}

function splitText(traffic: Record<string, number>): string {
  return Object.entries(traffic)
    .map(([revision, weight]) => `${revision} ${Math.round(weight * 1000) / 10}%`)
    .join(', ');
}
