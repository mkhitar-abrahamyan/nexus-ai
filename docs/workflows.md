# Workflows

<!-- covers: ./workflows -->
<!-- sources: src/workflow -->

Ready-made workflows from `nexus-ai-pro/workflows`, for common jobs you would otherwise prompt by hand.

- **Chains** answer from sources, extract structured data, classify, compare options, and summarize
  with verification.
- **Domain templates** triage support tickets, qualify sales leads, review contracts, and review code.

Each is a function over any client with a `complete()` method. It returns the final content, the
last response, and every step taken.

```ts
import { ragAnswer, supportTriageWorkflow } from 'nexus-ai-pro/workflows';

const answer = await ragAnswer(ai, { model: 'gpt-5.4-mini', question, chunks });
const triage = await supportTriageWorkflow(ai, { model: 'gpt-5.4-mini', input: ticket, customerTier: 'enterprise' });
console.log(triage.content, triage.steps.length);
```

## The shape every workflow shares

A workflow needs one thing from a client: a `complete()` method. That is the `WorkflowClient`
contract. A `NexusAI` client satisfies it, and so does a test double that returns scripted responses.

Every workflow returns a `WorkflowResult`:

- `content`, the final answer;
- `response`, the final response, with its usage and cost;
- `steps`, one `WorkflowStepResult` per completion — its name and its response — so you can see how
  the answer was reached.

The client also offers `ai.summarizeVerifyFormat()` directly.

## Chains

| Chain | What it does | Its options |
| --- | --- | --- |
| `ragAnswer()` | Answers a question from retrieved passages, citing them by id. | `RagAnswerOptions`: `model`, `question`, `chunks`, and `verify`, which repairs claims the passages do not support. A repair costs a second completion. |
| `extractStructured()` | Pulls data matching a JSON Schema out of text. The client validates the output. | `ExtractStructuredOptions`: `model`, `input`, `schema`, and an optional `instruction`. |
| `classifyRoute()` | Picks exactly one label, at temperature 0, answering `{ label, confidence }`. | `ClassifyRouteOptions`: `labels`, and an optional `instruction`. |
| `compareAndDecide()` | Weighs options against criteria and chooses one, reasoning privately first. | `CompareOptions`: `input`, `options`, and `criteria`. |
| `summarizeVerifyFormat()` | Summarizes, checks the summary against sources, and formats the result. | `SummarizeVerifyFormatOptions`, below. |

`SummarizeVerifyFormatOptions` takes the `input`, and optionally:

- `verifyContext`, the sources the summary must agree with. The verify step repairs any claim they do
  not support. Without sources, that step is skipped.
- `responseFormat`, applied only to the final answer;
- instructions that replace each step's default.

So it costs two completions, or three or four with verification.

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

The domain workflows answer in JSON with a fixed set of fields, so their output can be parsed and
routed. Each takes `DomainWorkflowOptions`: the `model`, the `input`, and optional `context` passages
for the prompt. Each also has one option of its own:

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
| `codeReviewWorkflow` | function | Reviews code for bugs, security risks, performance issues, and missing tests, as JSON findings ordered by severity. |
| `CodeReviewWorkflowOptions` | interface | Options for `codeReviewWorkflow()`. |
| `compareAndDecide` | function | Compares options against criteria and chooses one, reasoning privately before answering. |
| `CompareOptions` | interface | Options for `compareAndDecide`. |
| `DomainWorkflowOptions` | interface | What every domain workflow takes. |
| `extractStructured` | function | Extracts structured data matching a JSON schema. |
| `ExtractStructuredOptions` | interface | Options for `extractStructured`. |
| `legalReviewWorkflow` | function | Flags legal risks, missing clauses, and questions to ask, as JSON, with an explicit fallback when the text is not enough. |
| `LegalReviewWorkflowOptions` | interface | Options for `legalReviewWorkflow()`. |
| `ragAnswer` | function | Answers a question from retrieved passages with citations, optionally verifying and repairing the answer against them. |
| `RagAnswerOptions` | interface | Options for `ragAnswer`. |
| `salesQualificationWorkflow` | function | Qualifies a sales lead into a fit score, pain points, a recommended offer, and a follow-up email, as JSON. |
| `SalesWorkflowOptions` | interface | Options for `salesQualificationWorkflow()`. |
| `summarizeVerifyFormat` | function | Summarizes content, verifies the summary against sources when given, then formats it: two completions, or three to four with verification, each step returned. |
| `SummarizeVerifyFormatOptions` | interface | Options for `summarizeVerifyFormat`. |
| `supportTriageWorkflow` | function | Triages a support request into severity, category, next action, and a customer-safe reply, as JSON. |
| `SupportWorkflowOptions` | interface | Options for `supportTriageWorkflow()`. |
| `WorkflowClient` | interface | The one method a workflow needs from a client. |
| `WorkflowResult` | interface | The outcome of a workflow. |
| `WorkflowStepResult` | interface | One step of a workflow and the response it produced. |
<!-- reference:end -->
