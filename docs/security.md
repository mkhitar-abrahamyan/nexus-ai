# Guardrails and security

<!-- covers: ./security -->
<!-- sources: src/security src/types/security.ts -->

Guardrails check what goes into a model and what comes out. They come from `nexus-ai-pro/security`:

- on input: schema validation, prompt-injection and personal-data detection, secret and URL checks,
  and tool allowlists;
- on output: redaction, moderation, and a grounding check;
- for files: upload scanning.

They reduce risk. They do not replace authorization, or a person reviewing high-impact actions.

## Turning it on

Security is on by default, at the `standard` level. The client's `security` option takes a level, or a
full `SecurityConfig`: a level, a preset, and detailed input and output settings.

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  security: {
    level: 'strict',
    input: {
      injectionDetection: { enabled: true, onDetection: 'block' },
      pii: { enabled: true, action: 'mask', detect: ['email', 'phone', 'credit-card', 'aws-key', 'private-key'] },
      secrets: { enabled: true, action: 'block' },
    },
    output: { piiRedaction: true, maxContentLength: 8000 },
  },
});
```

A blocked request or response raises `NexusSecurityError`. Its `findings` say what was found. Every
matched value in them is redacted, so the error never repeats the leak.

## Levels

A `SecurityLevel` sets what runs when nothing more specific is configured:

| Level | What it does |
| --- | --- |
| `off` | Nothing. Streams are not buffered. |
| `basic` | Schema, secret, URL, and tool checks on input; redaction on output. |
| `standard` | Adds injection and PII detection. Both record findings rather than block. |
| `strict` | Injection blocks, and PII is masked. |
| `paranoid` | PII blocks too, after masking. |

Detailed settings override the level. For example, `onDetection: 'block'` blocks injection at
`standard`, and `pii.enabled: false` turns PII detection off at `paranoid`.

A `SecurityPreset` is a starting configuration for a kind of deployment: `developer`, `startup`,
`enterprise`, `healthcare`, or `finance`. Your own settings are merged over it.

## What the guardrails report

Every guardrail reports a `SecurityFinding`:

| Field | What it holds |
| --- | --- |
| guardrail | Which guardrail found it. |
| severity | From `low` to `critical`. |
| message, location | What was found, and where. |
| match, metadata | The matched value, and details specific to the guardrail. |

What a guardrail does with a match is its `SecurityAction`: let it through, block the request, mask
the match, or only record it.

A check returns a `SecurityResult`. It says whether the value may go ahead, and gives the value after
masking and redaction, the findings, and the guardrails that ran.

## Input guardrails

| Guardrail | What it checks | What it does by default |
| --- | --- | --- |
| Schema | The request's shape: roles, content parts, tool definitions. | Always blocks a malformed request. |
| Prompt injection | Known attack phrasings, plus your own patterns. | Depends on the level. |
| Semantic injection | Similarity to example attacks. Catches rephrasings no pattern lists. | Off until enabled. |
| Personal data | Email addresses, phone and card numbers, IP addresses, AWS keys, private keys. | Depends on the level. |
| Secrets | Private keys; cloud, payment, GitHub, Slack, and Google keys; JWTs; `password = "…"`. | Blocks. |
| URLs | Loopback and cloud-metadata addresses, onion services, secret-like query parameters. | Records. |
| Tools | Tools offered to the model that are not on `input.tools.allowedNames`. | Blocks. |
| Length | Text longer than `input.maxContentLength`. | Blocks. |

Each one is a class you can use on its own:

- `SchemaValidator` checks the request's shape.
- `InjectionDetector` matches instruction overrides, role jailbreaks, prompt exfiltration, and
  synthetic role tags, plus your `customPatterns`. `InjectionDetectionConfig.onDetection` blocks the
  request, records the finding, or, with `transform`, rewrites the attack phrases into inert markers
  and sends the request on.
- `SemanticInjectionClassifier` compares each message with example attacks by vector similarity.
  Enabled through `injectionDetection.semantic`, it uses hashed term vectors and needs no provider.
  For a real embedding model, construct it with `embed` and call its asynchronous `detect()`.
- `PIIDetector` finds each `PIIType`. `PIIConfig` chooses the types and the action: `mask` replaces
  the match, keeping its shape unless `preserveFormat` is off; `remove` deletes it; `block` refuses
  the request; and `flag` records it.
- `InputGuard` is the secret, URL, tool, and length checks together.

## Output guardrails

`OutputGuard` checks a response and its tool-call arguments. It:

- redacts secrets and personal data;
- removes database connection strings;
- records proprietary terms you name;
- cuts a response that is too long;
- applies moderation terms and forbidden topics;
- checks that the answer's words overlap the context you give it.

Moderation and topics block only when you tell them to. A blocked response's text is never returned,
not even inside the failed result.

## Running them yourself

`SecurityPipeline` runs everything, and it is what the client uses. Use it on its own to check text
that never goes through the client:

```ts
import { SecurityPipeline } from 'nexus-ai-pro/security';

const pipeline = new SecurityPipeline({ level: 'strict' });
const input = pipeline.protectInput(request);
pipeline.assertSafe(input); // throws NexusSecurityError when it failed
```

| Method | What it does |
| --- | --- |
| `protectInput()` | Checks a request. |
| `protectOutput()` | Checks a response. |
| `assertSafe()`, `assertOutputSafe()` | Throw `NexusSecurityError` for a result that failed. |

When security is on, streamed output is buffered and checked before any chunk is released. So a
secret split across chunks cannot leak in part. The [client guide](./core.md#streaming) has the
limits.

## Policies

`GUARDRAIL_POLICIES` holds bundled configurations, each named by a `GuardrailPolicyName`:

| Policy | What it does |
| --- | --- |
| `owasp-llm` | Blocks injection and secrets, flags risky URLs, and redacts output and connection strings. |
| `pii-safe` | Masks personal data on input, and redacts it on output. |
| `rag-grounded` | Checks that answers overlap the context you pass as `output.grounding.context`. |
| `tool-safe` | Blocks injection, and enforces a tool allowlist once you give it the names. |
| `enterprise-strict` | The enterprise preset, with URL blocking and data-loss checks. |

`guardrailPolicy()` returns one with your overrides merged over it:

```ts
import { guardrailPolicy } from 'nexus-ai-pro/security';

const ai = new NexusAI({
  providers,
  security: guardrailPolicy('tool-safe', { input: { tools: { allowedNames: ['search', 'lookup_order'] } } }),
});
```

## Hardening a prompt

`hardenPrompt()` wraps each plain-text user message in delimiters. It then puts a system instruction
first, telling the model to treat delimited text as data, not instructions. It detects nothing; it
makes an injection less likely to work. `PromptHardeningOptions` sets the delimiter and the
instruction.

## Calibrating the semantic classifier

The right similarity threshold depends on your traffic. `calibrateSemanticInjectionClassifier()`
scores the classifier at several thresholds against labelled prompts:

```ts
import { calibrateSemanticInjectionClassifier } from 'nexus-ai-pro/security';

for (const result of calibrateSemanticInjectionClassifier(myLabelledPrompts)) {
  console.log(result.threshold, result.precision, result.recall);
}
```

Each prompt is an `InjectionCalibrationExample`: the prompt, whether it is an attack, and a category.
Without your own, it uses `SEMANTIC_INJECTION_CALIBRATION_SET`: five attacks, and five safe prompts
that resemble them. Each threshold gets an `InjectionCalibrationResult`: accuracy, precision, recall,
and the false-positive and false-negative rates. It scores the hashed-vector check the pipeline runs.

## Scanning uploads

`UploadScanner` checks files before they reach a model or a store:

```ts
import { scanUploads } from 'nexus-ai-pro/security';

const result = scanUploads([{ name: 'notes.txt', content: text }]);
if (!result.ok) console.log(result.findings);
```

It checks four things, each set by `UploadScannerOptions`:

- the file's size;
- a blocked extension, executables and scripts by default;
- an allowed MIME type;
- forbidden patterns in text contents: private keys, cloud and GitHub tokens, and instruction
  overrides by default.

A `FileUpload` is a name, an optional MIME type and size, and the contents. An `UploadScanResult`
fails on any high or critical `UploadScanFinding`. Each finding names the file, the severity, the
problem, and the matched text. `scanUploads()` is a one-off scan. `ingestFilesAfterScan()`, in the
[grounding guide](./grounding.md), scans before it ingests.

## Elsewhere

- `createFetchUrlTool()`, in the [agents guide](./agents.md), fetches URLs safely. It pins DNS,
  validates redirects, blocks private networks, and bounds how much it reads.
- CLI scans and audit records redact detected values by default. `nexus scan --reveal-values` works
  only in an interactive terminal. Raw audit data needs both `includeSensitiveData: true` and an
  explicit custom sink.

## Limitations

- Detection works by pattern and similarity. It catches known phrasings and common formats, not
  every attack or every piece of personal data. Treat it as a layer, not a boundary.
- The grounding check compares words, not meaning. The [grounding guide](./grounding.md) has
  claim-level checks.
- Buffered streaming trades token-by-token latency for safety. Turn security off for a stream only
  when that trade is acceptable.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/security`

| Export | Kind | Summary |
| --- | --- | --- |
| `calibrateSemanticInjectionClassifier` | function | Scores the semantic injection classifier at several thresholds, so you can pick one for your own traffic. |
| `FileUpload` | interface | A file offered for upload. |
| `GUARDRAIL_POLICIES` | constant | The bundled guardrail presets, as security configurations. |
| `guardrailPolicy` | function | A bundled guardrail preset, with your overrides merged over it. |
| `GuardrailPolicyName` | type | Names of the bundled guardrail presets. |
| `InjectionCalibrationExample` | interface | One labelled prompt for calibrating the injection classifier. |
| `InjectionCalibrationResult` | interface | How the classifier performed at one threshold. |
| `InjectionDetector` | class | Finds prompt-injection attempts by pattern. |
| `InputGuard` | class | Checks requests for secrets, dangerous URLs, and other unsafe input. |
| `NexusSecurityError` | class | Raised when guardrails block a request or a response. |
| `OutputGuard` | class | Checks responses for leaked secrets, PII, and other unsafe output. |
| `PIIDetector` | class | Finds and masks personal data such as emails, phone numbers, and card numbers. |
| `scanUploads` | function | Scans a set of files with a one-off scanner. |
| `SchemaValidator` | class | Validates a request's shape before it is sent. |
| `SecurityPipeline` | class | Runs the input and output guardrails: schema validation, injection and PII detection, and output checks, at a security level or with a full configuration. |
| `SEMANTIC_INJECTION_CALIBRATION_SET` | constant | A small built-in calibration set: five attacks and five safe prompts that look like them. |
| `SemanticInjectionClassifier` | class | Finds prompt-injection attempts by embedding similarity to known attacks, catching rephrasings a pattern misses. |
| `UploadScanFinding` | interface | One problem found in an upload. |
| `UploadScanner` | class | Checks uploads for size, extension, MIME type, and forbidden content before they reach a model or a store. |
| `UploadScannerOptions` | interface | Options for scanning uploads. |
| `UploadScanResult` | interface | The outcome of scanning uploads. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `hardenPrompt` | function | Wraps user content in delimiters and adds a system instruction to treat it as data, not instructions. |
| `InjectionDetectionConfig` | interface | Prompt-injection detection on input. |
| `PIIConfig` | interface | Detection of personal data in input. |
| `PIIType` | type | Kinds of personal data and secrets the PII detector recognizes. |
| `SecurityAction` | type | What a guardrail does with a match: let it through, block the request, mask the match, or record it. |
| `SecurityConfig` | interface | Guardrails for input and output, from a preset, a level, or detailed settings. |
| `SecurityFinding` | interface | One thing a guardrail found. |
| `SecurityLevel` | type | How much protection a client applies, from none to maximal. |
| `SecurityResult` | interface | The outcome of running guardrails on a value. |
<!-- reference:end -->
