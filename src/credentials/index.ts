/**
 * Credentials per tenant: each provider's key resolved when a call is made, for the tenant it runs
 * for, from a secret manager the application supplies, cached for a bounded time and rotated without
 * a restart.
 */
import type {
  CredentialRequest,
  CredentialResolver,
  OperationDescriptor,
  ProviderCredential,
} from '../types/lifecycle.js';

export type { CredentialRequest, CredentialResolver, ProviderCredential } from '../types/lifecycle.js';

/** Where secrets are read: a secret manager, the environment, or memory. */
export interface SecretSource {
  /** The secret with this name, or `undefined` when there is none. Throws when the source cannot be read. */
  get(name: string, options?: { signal?: AbortSignal }): Promise<string | undefined> | string | undefined;
}

/** Raised when a call's credential cannot be resolved, so the call is refused rather than sent with another. */
export class CredentialError extends Error {
  constructor(
    message: string,
    /** The provider the call was for. */
    readonly provider: string,
    /** The tenant it ran for. */
    readonly tenantId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CredentialError';
  }
}

/** Options for `tenantCredentials()`. */
export interface TenantCredentialsOptions {
  /** Where the secrets are. */
  secrets: SecretSource;
  /**
   * The secret's name for a request. Defaults to `<tenant>/<provider>`, or `<provider>` for a call
   * with no tenant.
   */
  name?: (request: CredentialRequest) => string;
  /**
   * Reads a secret into a credential. Defaults to a plain string as the key, or a JSON object with
   * `apiKey` and `headers`.
   */
  parse?: (secret: string, request: CredentialRequest) => ProviderCredential;
  /**
   * What happens when a tenant has no secret: `refuse`, the default, fails the call with a
   * `CredentialError`; `config` sends the provider's configured key. A call with no tenant always
   * falls back to the configured key.
   */
  missing?: 'refuse' | 'config';
  /** How long a resolved credential is reused, in milliseconds. Defaults to 5 minutes. */
  cacheMs?: number;
  /** How long a missing secret is remembered as missing, in milliseconds. Defaults to 30 seconds. */
  missingCacheMs?: number;
  /**
   * When the source fails, keeps using a credential resolved before, for up to this long after it
   * was due again, in milliseconds. Defaults to 1 hour; 0 fails the call instead.
   */
  staleMs?: number;
  /** Most credentials cached at once. Defaults to 1,000. */
  maxEntries?: number;
  /** Hears each failure of the source, including those a stale credential covered. */
  onError?: (error: unknown, request: CredentialRequest) => void;
  /** Replaces the system clock, for tests. */
  now?: () => number;
}

/** A credential resolver over a secret source, with `stats()` and a way to forget what it cached. */
export interface TenantCredentials extends CredentialResolver {
  /** Forgets every cached credential, or those of one tenant, so the next calls read the source again. */
  clear(tenantId?: string): void;
  /** What the cache did: reads of the source, hits, stale credentials served, and refusals. */
  stats(): TenantCredentialStats;
}

/** Counts from `TenantCredentials.stats()`. */
export interface TenantCredentialStats {
  /** Times the source was read. */
  reads: number;
  /** Calls answered from the cache. */
  hits: number;
  /** Calls answered with a credential past its time, because the source failed. */
  stale: number;
  /** Calls refused for want of a credential. */
  refused: number;
  /** Credentials cached now. */
  cached: number;
}

interface Entry {
  credential: ProviderCredential | undefined;
  /** When it is due to be read again. */
  dueAt: number;
}

/**
 * Resolves each provider's credential per tenant from a secret source, at call time: a key in the
 * source is used from the next call that reads it, so a key rotated there takes over within
 * `cacheMs`, at once after `clear()`, and at once for a call whose provider refused the old one.
 * Concurrent calls for one credential share one read.
 *
 * ```ts
 * const ai = new NexusAI({
 *   providers: { openai: { apiKey: process.env.OPENAI_KEY } },
 *   lifecycle: { credentials: tenantCredentials({ secrets: awsSecrets(new SecretsManager({})) }) },
 * });
 * await ai.complete({ model: 'gpt-5', tenantId: 'acme', messages }); // acme's own key
 * ```
 */
export function tenantCredentials(options: TenantCredentialsOptions): TenantCredentials {
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  const missingCacheMs = options.missingCacheMs ?? 30_000;
  const staleMs = options.staleMs ?? 60 * 60_000;
  const maxEntries = Math.max(1, options.maxEntries ?? 1_000);
  const nameOf =
    options.name ?? ((request) => (request.tenantId ? `${request.tenantId}/${request.provider}` : request.provider));
  const parse = options.parse ?? parseSecret;
  const cache = new Map<string, Entry>();
  const reading = new Map<string, Promise<ProviderCredential | undefined>>();
  const counts = { reads: 0, hits: 0, stale: 0, refused: 0 };
  const keyOf = (request: Pick<CredentialRequest, 'provider' | 'tenantId'>) =>
    `${request.tenantId ?? ''}\u0000${request.provider}`;

  const keep = (key: string, entry: Entry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
  };

  const read = async (request: CredentialRequest, key: string, previous: Entry | undefined) => {
    counts.reads += 1;
    try {
      const secret = await options.secrets.get(nameOf(request));
      const credential = secret === undefined || secret === '' ? undefined : parse(secret, request);
      keep(key, { credential, dueAt: now() + (credential ? cacheMs : missingCacheMs) });
      return credential;
    } catch (error) {
      options.onError?.(error, request);
      // The source is down: a credential resolved before carries the call, for a while.
      if (previous?.credential && staleMs > 0 && now() - previous.dueAt <= staleMs) {
        counts.stale += 1;
        return previous.credential;
      }
      throw new CredentialError(
        `The credential for ${request.provider}${request.tenantId ? ` for tenant ${request.tenantId}` : ''} could not be read`,
        request.provider,
        request.tenantId,
        { cause: error },
      );
    }
  };

  const resolver: TenantCredentials = {
    async resolve(request) {
      const key = keyOf(request);
      const cached = cache.get(key);
      let credential: ProviderCredential | undefined;
      if (cached && cached.dueAt > now()) {
        counts.hits += 1;
        credential = cached.credential;
      } else {
        let pending = reading.get(key);
        if (!pending) {
          pending = read(request, key, cached).finally(() => reading.delete(key));
          reading.set(key, pending);
        }
        credential = await pending;
      }
      if (credential || request.tenantId === undefined || options.missing === 'config') return credential;
      counts.refused += 1;
      throw new CredentialError(
        `Tenant ${request.tenantId} has no credential for ${request.provider}`,
        request.provider,
        request.tenantId,
      );
    },
    invalidate(request) {
      cache.delete(keyOf(request));
    },
    clear(tenantId) {
      if (tenantId === undefined) cache.clear();
      else for (const key of [...cache.keys()]) if (key.startsWith(`${tenantId}\u0000`)) cache.delete(key);
    },
    stats() {
      return { ...counts, cached: cache.size };
    },
  };
  return resolver;
}

/** A secret as a credential: a plain string is the key; a JSON object carries `apiKey` and `headers`. */
export function parseSecret(secret: string): ProviderCredential {
  const text = secret.trim();
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text) as { apiKey?: unknown; headers?: unknown };
      const headers =
        value.headers && typeof value.headers === 'object'
          ? Object.fromEntries(
              Object.entries(value.headers as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : undefined;
      return {
        ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      };
    } catch {
      // Not JSON after all: the whole text is the key.
    }
  }
  return { apiKey: text };
}

// ── Sources ──

/**
 * Secrets in environment variables: `acme/openai` is read from `ACME_OPENAI`, with `prefix`
 * before it, such as `NEXUS_SECRET_`.
 */
export function envSecrets(options: { prefix?: string; env?: Record<string, string | undefined> } = {}): SecretSource {
  const env =
    options.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return {
    get: (name) => env[`${options.prefix ?? ''}${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`],
  };
}

/** Secrets held in this process, which `set()` changes: for tests, and for keys an application rotates itself. */
export interface MemorySecrets extends SecretSource {
  /** Stores or replaces a secret. */
  set(name: string, value: string): void;
  /** Removes a secret. */
  delete(name: string): void;
}

/** Secrets held in this process. */
export function memorySecrets(initial: Record<string, string> = {}): MemorySecrets {
  const values = new Map(Object.entries(initial));
  return {
    get: (name) => values.get(name),
    set: (name, value) => void values.set(name, value),
    delete: (name) => void values.delete(name),
  };
}

/** The part of AWS Secrets Manager's client a source needs, as `@aws-sdk/client-secrets-manager`'s `SecretsManager` has it. */
export interface AwsSecretsClient {
  /** Reads one secret's current value. */
  getSecretValue(input: { SecretId: string; VersionStage?: string }): Promise<{ SecretString?: string }>;
}

/** Secrets in AWS Secrets Manager, each named `<prefix><name>`. A secret that does not exist reads as none. */
export function awsSecrets(client: AwsSecretsClient, options: { prefix?: string } = {}): SecretSource {
  return {
    async get(name) {
      try {
        return (await client.getSecretValue({ SecretId: `${options.prefix ?? ''}${name}` })).SecretString;
      } catch (error) {
        if (errorName(error) === 'ResourceNotFoundException') return undefined;
        throw error;
      }
    },
  };
}

/** The part of Google Secret Manager's client a source needs, as `@google-cloud/secret-manager`'s has it. */
export interface GcpSecretsClient {
  /** Reads one version of a secret. */
  accessSecretVersion(request: {
    name: string;
  }): Promise<[{ payload?: { data?: Uint8Array | string | null } | null }, ...unknown[]]>;
}

/**
 * Secrets in Google Secret Manager under `projects/<project>/secrets/<name>/versions/<version>`. Names
 * may hold only letters, digits, `-`, and `_`, so `/` becomes `-`.
 */
export function gcpSecrets(client: GcpSecretsClient, options: { project: string; version?: string }): SecretSource {
  return {
    async get(name) {
      const id = name.replace(/[^A-Za-z0-9_-]/g, '-');
      try {
        const [version] = await client.accessSecretVersion({
          name: `projects/${options.project}/secrets/${id}/versions/${options.version ?? 'latest'}`,
        });
        const data = version.payload?.data;
        if (data === undefined || data === null) return undefined;
        return typeof data === 'string' ? data : new TextDecoder().decode(data);
      } catch (error) {
        if ((error as { code?: unknown }).code === 5) return undefined;
        throw error;
      }
    },
  };
}

/** The part of Azure Key Vault's client a source needs, as `@azure/keyvault-secrets`'s `SecretClient` has it. */
export interface AzureSecretsClient {
  /** Reads one secret's current value. */
  getSecret(name: string): Promise<{ value?: string }>;
}

/** Secrets in Azure Key Vault. Names may hold only letters, digits, and `-`, so anything else becomes `-`. */
export function azureSecrets(client: AzureSecretsClient): SecretSource {
  return {
    async get(name) {
      try {
        return (await client.getSecret(name.replace(/[^A-Za-z0-9-]/g, '-'))).value;
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        if (status === 404 || errorName(error) === 'SecretNotFound') return undefined;
        throw error;
      }
    },
  };
}

/** Options for `vaultSecrets()`. */
export interface VaultSecretsOptions {
  /** The Vault server, such as `https://vault.internal:8200`. */
  address: string;
  /** A token, or a function that returns the current one, for a token that is renewed. */
  token: string | (() => string | Promise<string>);
  /** The KV version 2 mount. Defaults to `secret`. */
  mount?: string;
  /** The field of the secret's data that holds the value. Defaults to `value`; with none present, the data as JSON. */
  field?: string;
  /** A Vault Enterprise namespace. */
  namespace?: string;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Secrets in HashiCorp Vault's KV version 2 engine, over its HTTP API. A secret that does not exist reads as none. */
export function vaultSecrets(options: VaultSecretsOptions): SecretSource {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    async get(name, getOptions) {
      const token = typeof options.token === 'string' ? options.token : await options.token();
      const path = name
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
      const response = await fetchImpl(
        `${options.address.replace(/\/+$/, '')}/v1/${options.mount ?? 'secret'}/data/${path}`,
        {
          headers: { 'x-vault-token': token, ...(options.namespace ? { 'x-vault-namespace': options.namespace } : {}) },
          ...(getOptions?.signal ? { signal: getOptions.signal } : {}),
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`Vault answered ${response.status} reading a secret`);
      const body = (await response.json()) as { data?: { data?: Record<string, unknown> } };
      const data = body.data?.data;
      if (!data) return undefined;
      const value = data[options.field ?? 'value'];
      if (typeof value === 'string') return value;
      return JSON.stringify(data);
    },
  };
}

function errorName(error: unknown): string | undefined {
  const named = error as { name?: unknown; code?: unknown };
  return typeof named?.name === 'string' ? named.name : typeof named?.code === 'string' ? named.code : undefined;
}

/** The parts of an operation a credential request names, for code that resolves one itself. */
export function credentialRequest(
  provider: string,
  operation: Pick<OperationDescriptor, 'family' | 'operation' | 'tenantId'>,
): CredentialRequest {
  return {
    provider,
    family: operation.family,
    operation: operation.operation,
    ...(operation.tenantId !== undefined ? { tenantId: operation.tenantId } : {}),
  };
}
