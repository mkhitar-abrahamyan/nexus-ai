# Workflows

<!-- covers: ./workflows -->

Ready-made workflows from `nexus-ai-pro/workflows`: chains for grounded answers, extraction, classification, comparison, and summarize-verify-format, and domain templates for support triage, sales qualification, legal review, and code review. Each is a function over any client with a `complete()` method, returning the final content, the last response, and every step.

```ts
import { ragAnswer, supportTriageWorkflow } from 'nexus-ai-pro/workflows';

const answer = await ragAnswer(ai, { model: 'gpt-5.4-mini', question, chunks });
const triage = await supportTriageWorkflow(ai, { model: 'gpt-5.4-mini', input: ticket, customerTier: 'enterprise' });
console.log(triage.content, triage.steps.length);
```

The domain workflows ask for JSON with a fixed set of fields, so their output can be parsed and routed. `legalReviewWorkflow()` adds an explicit fallback for text it cannot judge, and is not legal advice.

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
| `summarizeVerifyFormat` | function | Summarizes content, verifies the summary against sources when given, then formats it: three completions, each step returned. |
| `SummarizeVerifyFormatOptions` | interface | Options for `summarizeVerifyFormat`. |
| `WorkflowClient` | interface | The one method a workflow needs from a client. |
| `WorkflowResult` | interface | The outcome of a workflow. |
| `WorkflowStepResult` | interface | One step of a workflow and the response it produced. |
<!-- reference:end -->
