# Guardrails and security

<!-- covers: ./security -->
<!-- sources: src/security -->

Input and output guardrails from `nexus-ai-pro/security`: schema validation, prompt-injection and PII detection, secret and URL checks, and output redaction, at a security level or with a full configuration. They reduce risk; they do not replace authorization or human review of high-impact actions.

## Security

Security is enabled by default with `standard` mode.

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

Security levels:

- `off`
- `basic`
- `standard`
- `strict`
- `paranoid`

Useful helpers:

- prompt-injection detection and optional neutralization
- PII and secret detection
- output redaction
- URL and tool allowlist checks
- reusable policies through `guardrailPolicy(...)`
- `hardenPrompt(...)` for clearly delimiting untrusted input
- `createFetchUrlTool(...)` with DNS pinning, redirect validation, private-network blocking, and
  bounded response reads

CLI scans and audit records redact detected values by default. `nexus scan --reveal-values` is
restricted to an interactive terminal; raw audit data requires both `includeSensitiveData: true`
and an explicit custom sink.

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
| `scanUploads` | function | Scans a set of files with a one-off scanner. |
| `SEMANTIC_INJECTION_CALIBRATION_SET` | constant | A small built-in calibration set: five attacks and five safe prompts that look like them. |
| `UploadScanFinding` | interface | One problem found in an upload. |
| `UploadScanner` | class | Checks uploads for size, extension, MIME type, and forbidden content before they reach a model or a store. |
| `UploadScannerOptions` | interface | Options for scanning uploads. |
| `UploadScanResult` | interface | The outcome of scanning uploads. |
<!-- reference:end -->
