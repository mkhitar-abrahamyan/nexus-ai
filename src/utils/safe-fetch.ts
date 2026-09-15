import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/**
 * Network-safe HTTP GET: SSRF protection, pinned DNS, redirect policy, and a byte ceiling.
 *
 * Extracted from the web connector when image inputs needed the same protection for binary
 * payloads. Security code that exists twice drifts, and the copy that drifts is the one nobody
 * audited; both callers now share this module, and the web connector keeps its exact behavior.
 */

/**
 * A URL refused by policy rather than by the network.
 *
 * Kept distinct so a caller can tell "that address is not allowed" from "that server is down"
 * without matching on message text. Extends `Error`, so existing handlers are unaffected.
 */
export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

export type WebResolvedAddress = string | { address: string; family?: 4 | 6 };

export interface SafeFetchPolicy {
  allowedDomains?: string[];
  /** Explicitly allow loopback/private targets, for example a trusted local development service. */
  allowPrivateNetworks?: boolean;
  /** Cloud metadata endpoints remain denied unless this separate high-risk opt-in is enabled. */
  allowCloudMetadata?: boolean;
  /** Optional resolver for split-horizon DNS or deterministic tests. Every returned address is validated. */
  resolveHostname?: (hostname: string) => Promise<readonly WebResolvedAddress[]>;
  userAgent?: string;
}

export interface SafeFetchOptions extends SafeFetchPolicy {
  maxBytes: number;
  maxRedirects: number;
  signal: AbortSignal;
  accept?: string;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  ok: boolean;
  bytes: Buffer;
  /** True when the body was cut at `maxBytes`. */
  truncated: boolean;
  contentType?: string;
}

interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

interface RawResponse {
  status: number;
  ok: boolean;
  bytes: Buffer;
  truncated: boolean;
  location?: string;
  contentType?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CLOUD_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
  'metadata.packet.net',
]);
const CLOUD_METADATA_IPV4 = new Set([
  '100.100.100.200', // Alibaba Cloud
  '168.63.129.16', // Azure platform virtual IP
  '169.254.169.254', // AWS, GCP, Azure, OCI, and others
  '169.254.170.2', // AWS ECS task metadata
  '169.254.170.23', // AWS EKS Pod Identity credentials
]);
const CLOUD_METADATA_IPV6 = new Set([
  'fd00:ec2:0:0:0:0:0:23', // AWS EKS Pod Identity credentials
  'fd00:ec2:0:0:0:0:0:254', // AWS IMDS
  'fd20:ce:0:0:0:0:0:254', // Google Compute Engine metadata
]);

/**
 * Fetches a URL after validating every hop, following redirects up to the configured limit.
 *
 * Each redirect target is resolved and validated again, so a public URL cannot redirect into a
 * private address, and the socket is pinned to an address that passed validation so DNS cannot
 * be rebound between the check and the connect.
 */
export async function safeFetch(initialUrl: URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
  let currentUrl = initialUrl;
  const visited = new Set<string>();

  for (let redirectCount = 0; ; redirectCount += 1) {
    currentUrl.hash = '';
    if (visited.has(currentUrl.href)) throw new Error('URL redirect loop detected');
    visited.add(currentUrl.href);

    const target = await resolveAndValidateTarget(currentUrl, options);
    const response = await requestTarget(target, options);

    if (response.location && REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= options.maxRedirects) {
        throw new Error(`URL exceeded the maximum of ${options.maxRedirects} redirects`);
      }
      currentUrl = parseUrl(response.location, currentUrl);
      continue;
    }

    return {
      url: currentUrl.href,
      ok: response.ok,
      status: response.status,
      bytes: response.bytes,
      truncated: response.truncated,
      contentType: response.contentType,
    };
  }
}

function requestTarget(target: ResolvedTarget, options: SafeFetchOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: RawResponse) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const requestOptions: RequestOptions = {
      method: 'GET',
      signal: options.signal,
      family: target.family,
      headers: {
        accept: options.accept ?? '*/*',
        'accept-encoding': 'identity',
        'user-agent': validateUserAgent(options.userAgent || 'nexus-ai-pro'),
      },
      lookup: (
        _hostname: string,
        _lookupOptions: LookupOptions,
        callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
      ) => {
        if (_lookupOptions.all) {
          callback(null, [{ address: target.address, family: target.family }]);
          return;
        }
        callback(null, target.address, target.family);
      },
    };

    const onResponse = (response: IncomingMessage) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      const contentType = response.headers['content-type'];

      if (location && REDIRECT_STATUSES.has(status)) {
        finish({ status, ok: false, bytes: Buffer.alloc(0), truncated: false, location });
        response.destroy();
        return;
      }

      const buffers: Buffer[] = [];
      let retainedBytes = 0;

      response.on('data', (rawChunk: Buffer | Uint8Array | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const remaining = options.maxBytes - retainedBytes;

        if (remaining > 0) {
          const retained = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
          buffers.push(retained);
          retainedBytes += retained.byteLength;
        }

        if (chunk.byteLength > remaining) {
          finish({
            status,
            ok: status >= 200 && status < 300,
            bytes: Buffer.concat(buffers, retainedBytes),
            truncated: true,
            contentType,
          });
          response.destroy();
        }
      });
      response.once('end', () =>
        finish({
          status,
          ok: status >= 200 && status < 300,
          bytes: Buffer.concat(buffers, retainedBytes),
          truncated: false,
          contentType,
        }),
      );
      response.once('error', fail);
    };

    try {
      const startRequest = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = startRequest(target.url, requestOptions, onResponse);
      request.once('error', fail);
      request.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function resolveAndValidateTarget(url: URL, options: SafeFetchPolicy): Promise<ResolvedTarget> {
  assertAllowedUrl(url, options);
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);

  if (literalFamily) {
    assertSafeAddress(hostname, options);
    return { url, address: hostname, family: literalFamily as 4 | 6 };
  }

  let resolved: readonly WebResolvedAddress[];
  try {
    resolved = options.resolveHostname
      ? await options.resolveHostname(hostname)
      : await defaultResolveHostname(hostname);
  } catch {
    throw new Error(`Unable to resolve URL hostname ${hostname}`);
  }

  if (!resolved.length) throw new Error(`Unable to resolve URL hostname ${hostname}`);
  const addresses = resolved.map(normalizeResolvedAddress);

  // Validate every answer, not just the selected address. This rejects DNS
  // records that mix public and private destinations and pins the actual socket
  // to one of the addresses that passed validation.
  for (const address of addresses) assertSafeAddress(address.address, options);
  return { url, ...addresses[0] };
}

function assertAllowedUrl(url: URL, options: SafeFetchPolicy): void {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UrlPolicyError('Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new UrlPolicyError('URLs containing embedded credentials are not allowed');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error('URL must include a hostname');

  if (!options.allowCloudMetadata && isCloudMetadataHostname(hostname)) {
    throw new UrlPolicyError('Cloud metadata hostnames are not allowed');
  }
  if (!options.allowPrivateNetworks && isLocalHostname(hostname)) {
    throw new UrlPolicyError('Loopback and private-network hostnames are not allowed');
  }

  if (options.allowedDomains?.length) {
    const allowed = options.allowedDomains.some((domain) => {
      const normalizedDomain = normalizeAllowedDomain(domain);
      return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
    });
    if (!allowed) throw new UrlPolicyError(`URL domain ${hostname} is not allowed`);
  }
}

function assertSafeAddress(address: string, options: SafeFetchPolicy): void {
  const family = isIP(address);
  if (!family) throw new Error('DNS resolver returned an invalid IP address');

  if (!options.allowCloudMetadata && isCloudMetadataAddress(address, family)) {
    throw new UrlPolicyError('Cloud metadata addresses are not allowed');
  }

  const nonPublic = family === 4 ? isNonPublicIPv4(address) : isNonPublicIPv6(address);
  if (!options.allowPrivateNetworks && nonPublic) {
    throw new UrlPolicyError('URL resolved to a loopback, private, link-local, or otherwise non-public address');
  }
}

export function parseUrl(value: string, base?: URL): URL {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    throw new Error('Invalid URL');
  }
}

async function defaultResolveHostname(hostname: string): Promise<WebResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

function normalizeResolvedAddress(value: WebResolvedAddress): { address: string; family: 4 | 6 } {
  const address = typeof value === 'string' ? value : value.address;
  const family = isIP(address);
  if (!family) throw new Error('DNS resolver returned an invalid IP address');
  if (typeof value !== 'string' && value.family !== undefined && value.family !== family) {
    throw new Error('DNS resolver returned an address with an invalid family');
  }
  return { address, family: family as 4 | 6 };
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.replace(/\.$/, '').toLowerCase();
}

function normalizeAllowedDomain(domain: string): string {
  const normalized = domain.trim().replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '').toLowerCase();
  if (!normalized || ['/', ':', '@', '[', ']'].some((character) => normalized.includes(character))) {
    throw new Error(`Invalid allowed domain ${domain}`);
  }
  return normalizeHostname(new URL(`http://${normalized}`).hostname);
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'localhost.localdomain';
}

function isCloudMetadataHostname(hostname: string): boolean {
  for (const blocked of CLOUD_METADATA_HOSTS) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function isCloudMetadataAddress(address: string, family: number): boolean {
  if (family === 4) {
    // Link-local HTTP targets are overwhelmingly metadata/credential services.
    // Requiring the dedicated cloud-metadata opt-in keeps allowPrivateNetworks
    // from silently opening this higher-risk address range.
    return CLOUD_METADATA_IPV4.has(address) || address.startsWith('169.254.');
  }
  const normalized = normalizeIPv6(address);
  return normalized !== undefined && CLOUD_METADATA_IPV6.has(normalized);
}

function isNonPublicIPv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a, b] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function isNonPublicIPv6(address: string): boolean {
  const bytes = parseIPv6(address);
  if (!bytes) return true;

  // Globally routable unicast currently lives in 2000::/3. Rejecting every
  // other range also covers unspecified, loopback, ULA, link-local, multicast,
  // IPv4-mapped, and transition mechanisms that can conceal an IPv4 target.
  if ((bytes[0] & 0xe0) !== 0x20) return true;

  // Documentation, Teredo, and 6to4 space should not be fetched by a public URL tool.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  return false;
}

function parseIPv6(address: string): number[] | undefined {
  let input = address.split('%', 1)[0].toLowerCase();
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    if (lastColon === -1) return undefined;
    const ipv4 = input
      .slice(lastColon + 1)
      .split('.')
      .map(Number);
    if (ipv4.length !== 4 || ipv4.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return undefined;
    }
    input = `${input.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;

  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;

  return words.flatMap((word) => {
    const value = Number.parseInt(word, 16);
    return [value >> 8, value & 0xff];
  });
}

function normalizeIPv6(address: string): string | undefined {
  const bytes = parseIPv6(address);
  if (!bytes) return undefined;
  const words: string[] = [];
  for (let index = 0; index < bytes.length; index += 2) {
    words.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  }
  return words.join(':');
}

function validateUserAgent(value: string): string {
  if (!value || /[\r\n]/.test(value)) throw new Error('userAgent must be a valid HTTP header value');
  return value;
}

export function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

export function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`${name} must be a non-negative integer`);
  return resolved;
}
