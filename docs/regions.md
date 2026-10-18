# Regions and credentials

<!-- covers: ./credentials -->

Each tenant's provider keys, resolved when a call is made from the secret manager you already run,
rotated there without a restart, and kept out of every error, log, trace, and audit event.

```ts
import { NexusAI } from 'nexus-ai-pro';
import { awsSecrets, tenantCredentials } from 'nexus-ai-pro/credentials';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY ?? '' } },
  lifecycle: { credentials: tenantCredentials({ secrets: awsSecrets(new SecretsManager({})) }) },
});

// Sent with acme's own key, read from the secret `acme/openai`.
await ai.complete({ model: 'gpt-5', tenantId: 'acme', messages: [{ role: 'user', content: 'Hello' }] });
```

## Credentials per tenant

`LifecycleConfig.credentials` takes a `CredentialResolver`: something that turns a
`CredentialRequest` (the provider, by the name it is registered under, the tenant, the family, and
the operation) into a `ProviderCredential`, an `apiKey` and any `headers`. Every family runs through
the lifecycle, so the resolver is asked for each provider a call reaches. An adapter sends what it
returns in place of the key it was configured with: OpenAI and every OpenAI-compatible provider as a
bearer token (in `api-key` for Azure, as its `credentialHeader` says), Anthropic in `x-api-key`,
Gemini in the URL, Cohere, embeddings, and images in their own headers. A resolver that returns
nothing leaves the configured key; one that throws refuses the call.

`tenantCredentials()` is the resolver over a `SecretSource`, any object with `get(name)`. It reads
the secret named `<tenant>/<provider>`, or `<provider>` for a call with no tenant, or whatever `name`
returns, and `parseSecret()` reads it into a credential: a plain string is the key, and a JSON object
carries `apiKey` and `headers`, such as an organization. `TenantCredentialsOptions`:

| Option | Default | What it does |
| --- | --- | --- |
| `secrets` | — | Where the secrets are. |
| `name`, `parse` | as above | The secret's name for a request, and how it becomes a credential. |
| `missing` | `refuse` | A tenant with no secret is refused with a `CredentialError` before anything is sent, or, with `config`, sent the configured key. |
| `cacheMs` | 5 minutes | How long a credential is reused before the source is read again. |
| `missingCacheMs` | 30 seconds | How long a missing secret is remembered as missing. |
| `staleMs` | 1 hour | While the source fails, how long a credential past its time still carries calls. |
| `maxEntries` | 1,000 | Credentials cached at once, the least recently read dropped first. |
| `onError` | — | Hears each failure of the source. |

Calls that need one credential at the same moment share one read of the source. A `TenantCredentials`
also has `clear()`, which forgets every cached credential or one tenant's, and `stats()`, which
returns `TenantCredentialStats`: reads, hits, stale credentials served, refusals, and what is cached.

**Rotation.** A key changed in the secret manager is used from the next call that reads the source:
within `cacheMs`, or at once after `clear()`. When the provider has already revoked the old key, it
is sooner still. A completion or a stream refused for its credential is resolved again and made once
more on the new key, without counting as a retry. In any other family, the operation fails and the
next one reads the source again. A key the source still holds, and the provider still refuses, fails
the call after that one more attempt.

**Never written down.** Every key and header value an operation resolves is removed from the errors it
raises, before anything records them: the message, the stack, the cause, and the fields they hold,
so a provider that says which key it refused is quoted with `[redacted]` in its place. The audit log,
the logs, traces, and the provider health report see the cleaned error, and a credential is never
part of a request, so it never reaches a trace or a cache.

### Secret sources

Each source reads a secret that does not exist as none, and throws when the store cannot be read.
None needs a dependency: each takes a client you build with the vendor's own SDK, through the
methods it already has.

| Source | Reads from |
| --- | --- |
| `awsSecrets(client, { prefix })` | AWS Secrets Manager, through an `AwsSecretsClient`, such as `SecretsManager` from `@aws-sdk/client-secrets-manager`. |
| `gcpSecrets(client, { project, version })` | Google Secret Manager, through a `GcpSecretsClient`, such as the `@google-cloud/secret-manager` client. `/` in a name becomes `-`. |
| `azureSecrets(client)` | Azure Key Vault, through an `AzureSecretsClient`, such as `SecretClient` from `@azure/keyvault-secrets`. Anything but letters, digits, and `-` becomes `-`. |
| `vaultSecrets(options)` | HashiCorp Vault's KV version 2 engine, over HTTP, by `VaultSecretsOptions`: the `address`, a `token` or a function that returns the current one, the `mount` (`secret`), the `field` (`value`), and a `namespace`. |
| `envSecrets({ prefix, env })` | Environment variables: `acme/openai` is read from `ACME_OPENAI`, after `prefix`. |
| `memorySecrets(initial)` | This process, as `MemorySecrets`, whose `set()` and `delete()` change it: for tests, and for keys an application rotates itself. |

`credentialRequest()` builds the request a resolver receives, for code that resolves a credential
outside a call.

In the test suite, a provider of the test's own takes only the keys it is told are live. Each tenant's
calls carry its own key through completions, streams, and embeddings. In a run of five calls whose
key is rotated after the second, and revoked by the provider, the third is refused, resolved again,
and answered on the new key, and every call after it uses that key. A key the provider quotes back in
its refusal is found in no error, stack, cause, audit event, log, trace, or health report.

## Limitations

- Realtime sessions, telephony, video, voice, media understanding, and batches send the key each
  provider was configured with; per-tenant credentials reach completions, streams, embeddings, and
  images.
- A resolved key is removed from errors when it is at least four characters long, and only where it
  appears whole.
