# Workflows

<!-- covers: ./workflows -->
<!-- sources: src/workflow -->

Ready-made workflows from `nexus-ai-pro/workflows`: chains for grounded answers, extraction, classification, comparison, and summarize-verify-format, and domain templates for support triage, sales qualification, legal review, and code review. Each is a function over any client with a `complete()` method, returning the final content, the last response, and every step.

```ts
import { ragAnswer, supportTriageWorkflow } from 'nexus-ai-pro/workflows';

const answer = await ragAnswer(ai, { model: 'gpt-5.4-mini', question, chunks });
const triage = await supportTriageWorkflow(ai, { model: 'gpt-5.4-mini', input: ticket, customerTier: 'enterprise' });
console.log(triage.content, triage.steps.length);
```

## The shape every workflow shares

A workflow needs one thing from a client: a `complete()` method, the `WorkflowClient` contract. A
`NexusAI` client satisfies it, and so does a test double that returns scripted responses. Every
workflow returns a `WorkflowResult`: the final `content`, the final `response` with its usage and
cost, and `steps`, a `WorkflowStepResult` per completion — its name and its response — so you can see
how the answer was reached. The client also exposes `ai.summarizeVerifyFormat()` directly.

## Chains

- **`ragAnswer()`** answers a question from retrieved passages and cites them by id. `RagAnswerOptions`
  takes the `model`, the `question`, the `chunks`, and `verify`, which checks the answer against the
  passages and repairs any claim they do not support, at the cost of a second completion when a
  repair is needed.
- **`extractStructured()`** pulls data matching a JSON Schema out of text. `ExtractStructuredOptions`
  takes the `model`, the `input`, the `schema`, and an `instruction` to replace the default one. The
  client validates the output against the schema.
- **`classifyRoute()`** picks exactly one label, at temperature 0, and answers `{ label, confidence }`
  as JSON. `ClassifyRouteOptions` takes the `labels` and an optional `instruction`.
- **`compareAndDecide()`** weighs options against criteria and chooses one, reasoning privately before
  it answers. `CompareOptions` takes the `input`, the `options`, and the `criteria`.
- **`summarizeVerifyFormat()`** summarizes, verifies, and formats. `SummarizeVerifyFormatOptions` takes
  the `input`, `verifyContext` — the sources the summary must agree with — a `responseFormat` for the
  final answer, and instructions to replace the defaults. With sources, the verify step restates the
  summary against them and repairs any claim they do not support; without them, it is skipped. The
  format is applied only in the last step, so it is two completions, or three or four with
  verification.

```ts
import { summarizeVerifyFormat } from 'nexus-ai-pro/workflows';

const brief = await summarizeVerifyFormat(ai, {
  model: 'gpt-5.4-mini',
  input: meetingNotes,
  verifyContext: [decisionLog],
  responseFormat: { type: 'json_schema', schema: briefSchema },
});
```

## Domain templates

The domain workflows ask for JSON with a fixed set of fields, so their output can be parsed and
routed. Each takes `DomainWorkflowOptions` — the `model`, the `input`, and optional `context` passages
included in the prompt — plus one field of its own:

| Workflow | Its option | Required fields in the answer |
| --- | --- | --- |
| `supportTriageWorkflow()` | `SupportWorkflowOptions.customerTier` | `severity`, `category`, `nextAction`, `reply` |
| `salesQualificationWorkflow()` | `SalesWorkflowOptions.product` | `fitScore`, `painPoints`, `recommendedOffer`, `followUpEmail` |
| `legalReviewWorkflow()` | `LegalReviewWorkflowOptions.jurisdiction` | `risks`, `suggestedQuestions`, `safeSummary` |
| `codeReviewWorkflow()` | `CodeReviewWorkflowOptions.language` | `findings`, `riskLevel`, `testSuggestions` |

`legalReviewWorkflow()` adds an explicit fallback for text it cannot judge, reasons privately, and is
not legal advice. Each template is one completion, so it is a starting point to copy and adapt, not
a fixed product.

## Limitations

- The templates name their required fields but not their types; add your own schema through
  `extractStructured()` when a field's shape matters.
- Verification compares claims with the sources as text; see the [grounding guide](./grounding.md)
  for how, and for what it cannot catch.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/workflows`

| Export | Kind | Summary |
| --- | --- | --- |
| `classifyRoute` | function | Picks exactly one label for the input, at temperature 0, returning `{ label, confidence }` as JSON. |
| `ClassifyRouteOptions` | interface | Options for `classifyRoute`. |
| `compareAndDecide` | function | Compares options against criteria and chooses one, reasoning privately before answering. |
| `CompareOptions` | interface | Options for `compareAndDecide`. |
| `extractStructured` | function | Extracts structured data matching a JSON schema. |
| `ExtractStructuredOptions` | interface | Options for `extractStructured`. |
| `ragAnswer` | function | Answers a question from retrieved passages with citations, optionally verifying and repairing the answer against them. |
| `RagAnswerOptions` | interface | Options for `ragAnswer`. |
| `summarizeVerifyFormat` | function | Summarizes content, verifies the summary against sources when given, then formats it: two completions, or three to four with verification, each step returned. |
| `SummarizeVerifyFormatOptions` | interface | Options for `summarizeVerifyFormat`. |
| `WorkflowClient` | interface | The one method a workflow needs from a client. |
| `WorkflowResult` | interface | The outcome of a workflow. |
| `WorkflowStepResult` | interface | One step of a workflow and the response it produced. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `codeReviewWorkflow` | function | Reviews code for bugs, security risks, performance issues, and missing tests, as JSON findings ordered by severity. |
| `CodeReviewWorkflowOptions` | interface | Options for `codeReviewWorkflow()`. |
| `DomainWorkflowOptions` | interface | What every domain workflow takes. |
| `legalReviewWorkflow` | function | Flags legal risks, missing clauses, and questions to ask, as JSON, with an explicit fallback when the text is not enough. |
| `LegalReviewWorkflowOptions` | interface | Options for `legalReviewWorkflow()`. |
| `salesQualificationWorkflow` | function | Qualifies a sales lead into a fit score, pain points, a recommended offer, and a follow-up email, as JSON. |
| `SalesWorkflowOptions` | interface | Options for `salesQualificationWorkflow()`. |
| `supportTriageWorkflow` | function | Triages a support request into severity, category, next action, and a customer-safe reply, as JSON. |
| `SupportWorkflowOptions` | interface | Options for `supportTriageWorkflow()`. |
<!-- reference:end -->
