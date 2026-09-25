# Guardrails and security

<!-- covers: ./security -->
<!-- sources: src/security src/types/security.ts -->

Input and output guardrails from `nexus-ai-pro/security`: schema validation, prompt-injection and PII
detection, secret and URL checks, tool allowlists, output redaction, moderation, and upload scanning,
at a security level or with a full configuration. They reduce risk; they do not replace
authorization or human review of high-impact actions.

## Turning it on

Security is on by default at the `standard` level. The client's `security` option takes a level, or a
`SecurityConfig` with a level, a preset, and detailed input and output settings:

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  security: {
    level: 'strict',
    input: {
      injectionDetection: { enabled: true, onDetection: 'block' },
      pii: {
        enabled: true,
        action: 'mask',
        detect: ['email', 'phone', 'credit-card', 'aws-key', 'private-key'],
      },
      secrets: { enabled: true, action: 'block' },
    },
    output: {
      piiRedaction: true,
      maxContentLength: 8000,
    },
  },
});
```

A blocked request or response raises `NexusSecurityError`, whose `findings` say what was found with
every matched value redacted, so the error itself never repeats the leak.

## Levels

`SecurityLevel` sets what runs when nothing more specific is configured:

| Level | What it does |
| --- | --- |
| `off` | Nothing. Streams are not buffered. |
| `basic` | Schema validation, secret and URL detection, and the tool allowlist on input; redaction on output |
| `standard` | Adds prompt-injection and PII detection, both recorded rather than blocking |
| `strict` | Injection blocks, and PII is masked |
| `paranoid` | PII blocks too, after masking |

Detailed settings override the level: `onDetection: 'block'` blocks injection at `standard`, and
`pii.enabled: false` turns PII detection off at `paranoid`. A `SecurityPreset` — `developer`,
`startup`, `enterprise`, `healthcare`, or `finance` — is a starting configuration for a kind of
deployment, with your own settings merged over it.

## What each guardrail does

Every guardrail reports a `SecurityFinding`: which guardrail found it, a severity from `low` to
`critical`, a message, where it was found, the matched value, and guardrail-specific metadata. What a
guardrail does with a match is its `SecurityAction` — let it through, block the request, mask the
match, or only record it. A running check returns a `SecurityResult`: whether the value may go
ahead, the value after masking and redaction, the findings, and the guardrails that ran.

On input:

- **Schema.** `SchemaValidator` checks the request's shape — roles, content parts, tool definitions —
  and a malformed request is always blocked.
- **Prompt injection.** `InjectionDetector` matches known attack phrasings — instruction overrides,
  role jailbreaks, prompt exfiltration, and synthetic role tags — plus your own `customPatterns`.
  `InjectionDetectionConfig.onDetection` blocks the request, records the finding, or, with
  `transform`, rewrites the attack phrases into inert markers and sends the request on.
- **Semantic injection.** `SemanticInjectionClassifier` compares each message with example attacks by
  vector similarity, which catches a rephrasing no pattern lists. Enabled through
  `injectionDetection.semantic`, it compares hashed term vectors, needing no provider. For a real
  embedding model, construct it with `embed` and call its asynchronous `detect()`.
- **Personal data.** `PIIDetector` finds each `PIIType` — email addresses, phone numbers, card
  numbers, IP addresses, AWS keys, and private keys. `PIIConfig` chooses the types and the action:
  `mask` replaces the match, keeping its shape unless `preserveFormat` is off; `remove` deletes it;
  `block` refuses the request; and `flag` records it.
- **Secrets.** Private keys, cloud, payment, GitHub, Slack, and Google keys, JWTs, and secret
  assignments such as `password = "…"` block the request by default, or are masked or recorded.
- **URLs.** Loopback and cloud-metadata addresses, onion services, and URLs carrying secret-like
  query parameters are recorded, or block the request with `action: 'block'`.
- **Tools.** `input.tools.allowedNames` blocks a request that offers the model any other tool.
- **Length.** `input.maxContentLength` blocks a request whose text is longer.

`InputGuard` is the secrets, URL, tool, and length checks on their own.

On output, `OutputGuard` redacts secrets and personal data from the response and from tool-call
arguments, removes database connection strings, records proprietary terms you name, cuts an
over-long response, and applies moderation terms, forbidden topics, and a word-overlap grounding
check. Moderation and topics block only when told to; a blocked response's text is never returned,
even inside the failed result.

`SecurityPipeline` runs all of it, and is what the client uses: `protectInput()` and `protectOutput()`
check a request and a response, and `assertSafe()` and `assertOutputSafe()` throw
`NexusSecurityError` for a result that failed. Use it on its own to check text that never goes through
the client.

When security is on, streamed output is buffered and checked before any chunk is released, so a
secret split across chunks cannot leak partially; the [client guide](./core.md#streaming) has the
limits.

## Policies

`GUARDRAIL_POLICIES` holds bundled configurations, named by `GuardrailPolicyName`:

- `owasp-llm` blocks injection and secrets, flags risky URLs, and redacts output and connection
  strings.
- `pii-safe` masks personal data on input and redacts it on output.
- `rag-grounded` checks that answers overlap the context, once you pass it as `output.grounding.context`.
- `tool-safe` blocks injection and enforces a tool allowlist, once you give it the names.
- `enterprise-strict` is the enterprise preset with URL blocking and data-loss checks.

`guardrailPolicy()` returns one with your overrides merged over it:

```ts
import { guardrailPolicy } from 'nexus-ai-pro/security';

const ai = new NexusAI({
  providers,
  security: guardrailPolicy('tool-safe', { input: { tools: { allowedNames: ['search', 'lookup_order'] } } }),
});
```

## Hardening a prompt

`hardenPrompt()` wraps each plain-text user message in delimiters and puts a system instruction first telling
the model to treat delimited text as data, not instructions. It does not detect anything; it makes
an injection less likely to work. `PromptHardeningOptions` sets the delimiter and the instruction.

## Calibrating the semantic classifier

The right similarity threshold depends on your traffic. `calibrateSemanticInjectionClassifier()`
scores the classifier at several thresholds against labelled prompts and returns an
`InjectionCalibrationResult` for each: accuracy, precision, recall, and the false-positive and
false-negative rates. It takes your own `InjectionCalibrationExample` values — a prompt, whether it
is an attack, and a category — or defaults to `SEMANTIC_INJECTION_CALIBRATION_SET`, five attacks and
five safe prompts that resemble them. It scores the hashed-vector check the pipeline runs.

```ts
import { calibrateSemanticInjectionClassifier } from 'nexus-ai-pro/security';

for (const result of calibrateSemanticInjectionClassifier(myLabelledPrompts)) {
  console.log(result.threshold, result.precision, result.recall);
}
```

## Scanning uploads

`UploadScanner` checks files before they reach a model or a store: size, a blocked extension
(executables and scripts by default), an allowed MIME type, and forbidden patterns in text contents
(private keys, cloud and GitHub tokens, and instruction overrides by default). `UploadScannerOptions`
sets each. A `FileUpload` is a name, an optional MIME type and size, and the contents. The
`UploadScanResult` fails on any high or critical `UploadScanFinding`, each naming the file, the
severity, the problem, and the matched text. `scanUploads()` is a one-off scan, and
`ingestFilesAfterScan()` in the [grounding guide](./grounding.md) scans before it ingests.

## Elsewhere

- `createFetchUrlTool()`, in the [agents guide](./agents.md), fetches URLs with DNS pinning,
  redirect validation, private-network blocking, and bounded reads.
- CLI scans and audit records redact detected values by default. `nexus scan --reveal-values` is
  restricted to an interactive terminal; raw audit data requires both `includeSensitiveData: true`
  and an explicit custom sink.

## Limitations

- Detection is by pattern and similarity. It catches known phrasings and common formats, not every
  attack or every piece of personal data; treat it as a layer, not a boundary.
- The grounding check compares words, not meaning. The [grounding guide](./grounding.md) has
  claim-level checks.
- Buffered streaming trades token-by-token latency for safety; turn security off for a stream only
  when that trade is acceptable.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/security`

| Export | Kind | Summary |
| --- | --- | --- |
| `InjectionDetector` | class | Finds prompt-injection attempts by pattern. |
| `InputGuard` | class | Checks requests for secrets, dangerous URLs, and other unsafe input. |
| `NexusSecurityError` | class | Raised when guardrails block a request or a response. |
| `OutputGuard` | class | Checks responses for leaked secrets, PII, and other unsafe output. |
| `PIIDetector` | class | Finds and masks personal data such as emails, phone numbers, and card numbers. |
| `SchemaValidator` | class | Validates a request's shape before it is sent. |
| `SecurityPipeline` | class | Runs the input and output guardrails: schema validation, injection and PII detection, and output checks, at a security level or with a full configuration. |
| `SemanticInjectionClassifier` | class | Finds prompt-injection attempts by embedding similarity to known attacks, catching rephrasings a pattern misses. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `calibrateSemanticInjectionClassifier` | function | Scores the semantic injection classifier at several thresholds, so you can pick one for your own traffic. |
| `FileUpload` | interface | A file offered for upload. |
| `GUARDRAIL_POLICIES` | constant | The bundled guardrail presets, as security configurations. |
| `guardrailPolicy` | function | A bundled guardrail preset, with your overrides merged over it. |
| `GuardrailPolicyName` | type | Names of the bundled guardrail presets. |
| `hardenPrompt` | function | Wraps user content in delimiters and adds a system instruction to treat it as data, not instructions. |
| `InjectionCalibrationExample` | interface | One labelled prompt for calibrating the injection classifier. |
| `InjectionCalibrationResult` | interface | How the classifier performed at one threshold. |
| `InjectionDetectionConfig` | interface | Prompt-injection detection on input. |
| `PIIConfig` | interface | Detection of personal data in input. |
| `PIIType` | type | Kinds of personal data and secrets the PII detector recognizes. |
| `scanUploads` | function | Scans a set of files with a one-off scanner. |
| `SecurityAction` | type | What a guardrail does with a match: let it through, block the request, mask the match, or record it. |
| `SecurityConfig` | interface | Guardrails for input and output, from a preset, a level, or detailed settings. |
| `SecurityFinding` | interface | One thing a guardrail found. |
| `SecurityLevel` | type | How much protection a client applies, from none to maximal. |
| `SecurityResult` | interface | The outcome of running guardrails on a value. |
| `SEMANTIC_INJECTION_CALIBRATION_SET` | constant | A small built-in calibration set: five attacks and five safe prompts that look like them. |
| `UploadScanFinding` | interface | One problem found in an upload. |
| `UploadScanner` | class | Checks uploads for size, extension, MIME type, and forbidden content before they reach a model or a store. |
| `UploadScannerOptions` | interface | Options for scanning uploads. |
| `UploadScanResult` | interface | The outcome of scanning uploads. |
<!-- reference:end -->
