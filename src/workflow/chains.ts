import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { ResponseFormatConfig } from '../types/config.js';
import { withFactualDefaults } from '../hallucination/factual.js';
import { withRagContext, type RagChunk } from '../hallucination/rag.js';
import { completeVerified, type VerificationOptions } from '../hallucination/verification.js';

/**
 * The one method a workflow needs from a client. A `NexusAI` client fits, and so does a test
 * double.
 */
export interface WorkflowClient {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

/** One step of a workflow and the response it produced. */
export interface WorkflowStepResult {
  /** The step's name, such as `summarize` or `verify`. */
  step: string;
  /** Its response. */
  response: NexusResponse;
}

/** The outcome of a workflow. */
export interface WorkflowResult {
  /** The final answer's text. */
  content: string;
  /** The final step's response. */
  response: NexusResponse;
  /** Every step, in order, for inspecting how the answer was reached. */
  steps: WorkflowStepResult[];
}

/** Options for `summarizeVerifyFormat`. */
export interface SummarizeVerifyFormatOptions {
  /** Model used for every step. */
  model: string;
  /** The content to summarize. */
  input: string;
  /** Sources to check the summary against. Without them, verification is skipped. */
  verifyContext?: string[];
  /** Format of the final answer, such as a JSON schema. */
  responseFormat?: ResponseFormatConfig;
  /** Replaces the default summarization instruction. */
  summaryInstruction?: string;
  /** Replaces the default formatting instruction. */
  finalInstruction?: string;
}

/** Options for `ragAnswer`. */
export interface RagAnswerOptions {
  /** Model that answers. */
  model: string;
  /** The question. */
  question: string;
  /** Retrieved passages the answer must cite. */
  chunks: RagChunk[];
  /** Checks the answer against the passages and repairs unsupported claims. */
  verify?: boolean;
}

/** Options for `extractStructured`. */
export interface ExtractStructuredOptions {
  /** Model that extracts. */
  model: string;
  /** The text to extract from. */
  input: string;
  /** JSON Schema the extraction must match. */
  schema: Record<string, unknown>;
  /** Replaces the default extraction instruction. */
  instruction?: string;
}

/** Options for `classifyRoute`. */
export interface ClassifyRouteOptions {
  /** Model that classifies. */
  model: string;
  /** The text to classify. */
  input: string;
  /** The labels to choose from. */
  labels: string[];
  /** Replaces the default classification instruction. */
  instruction?: string;
}

/** Options for `compareAndDecide`. */
export interface CompareOptions {
  /** Model that decides. */
  model: string;
  /** What the decision is about. */
  input: string;
  /** The options to choose between. */
  options: string[];
  /** What the choice should weigh. */
  criteria?: string[];
}

type RequestResponseFormat = CompletionRequest['responseFormat'];

/**
 * Summarizes content, verifies the summary against sources when given, then formats it: three
 * completions, each step returned.
 */
export async function summarizeVerifyFormat(
  client: WorkflowClient,
  options: SummarizeVerifyFormatOptions,
): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  const summary = await client.complete(
    withFactualDefaults(
      {
        model: options.model,
        messages: [
          {
            role: 'user',
            content: `${options.summaryInstruction || 'Summarize the following content clearly.'}\n\n${options.input}`,
          },
        ],
      },
      { chainOfThought: 'private' },
    ),
  );
  steps.push({ step: 'summarize', response: summary });

  const verified = options.verifyContext?.length
    ? await completeVerified(
        client,
        {
          model: options.model,
          messages: [{ role: 'user', content: summary.content }],
          responseFormat: toRequestResponseFormat(options.responseFormat),
        },
        {
          context: options.verifyContext,
          repair: true,
        } satisfies VerificationOptions,
      )
    : summary;
  steps.push({ step: 'verify', response: verified });

  const formatted = await client.complete({
    model: options.model,
    messages: [
      {
        role: 'user',
        content: `${options.finalInstruction || 'Format this into the final answer.'}\n\n${verified.content}`,
      },
    ],
    responseFormat: toRequestResponseFormat(options.responseFormat),
  });
  steps.push({ step: 'format', response: formatted });

  return {
    content: formatted.content,
    response: formatted,
    steps,
  };
}

/**
 * Answers a question from retrieved passages with citations, optionally verifying and repairing the
 * answer against them.
 */
export async function ragAnswer(client: WorkflowClient, options: RagAnswerOptions): Promise<WorkflowResult> {
  const request = withRagContext(
    {
      model: options.model,
      messages: [{ role: 'user', content: options.question }],
    },
    {
      chunks: options.chunks,
      requireCitations: true,
    },
  );

  const response = options.verify
    ? await completeVerified(client, request, { context: options.chunks.map((chunk) => chunk.content), repair: true })
    : await client.complete(request);

  return {
    content: response.content,
    response,
    steps: [{ step: 'rag-answer', response }],
  };
}

/** Extracts structured data matching a JSON schema. */
export async function extractStructured(
  client: WorkflowClient,
  options: ExtractStructuredOptions,
): Promise<WorkflowResult> {
  const response = await client.complete({
    model: options.model,
    messages: [
      {
        role: 'user',
        content: `${options.instruction || 'Extract the requested structured data from the input.'}\n\n${options.input}`,
      },
    ],
    responseFormat: {
      type: 'json_schema',
      schema: options.schema,
    },
  });

  return { content: response.content, response, steps: [{ step: 'extract-structured', response }] };
}

/**
 * Picks exactly one label for the input, at temperature 0, returning `{ label, confidence }` as
 * JSON.
 */
export async function classifyRoute(client: WorkflowClient, options: ClassifyRouteOptions): Promise<WorkflowResult> {
  const response = await client.complete({
    model: options.model,
    messages: [
      {
        role: 'user',
        content: [
          options.instruction || 'Classify the input into exactly one label.',
          `Labels: ${options.labels.join(', ')}`,
          `Input: ${options.input}`,
        ].join('\n'),
      },
    ],
    temperature: 0,
    responseFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  });

  return { content: response.content, response, steps: [{ step: 'classify-route', response }] };
}

/** Compares options against criteria and chooses one, reasoning privately before answering. */
export async function compareAndDecide(client: WorkflowClient, options: CompareOptions): Promise<WorkflowResult> {
  const response = await client.complete(
    withFactualDefaults(
      {
        model: options.model,
        messages: [
          {
            role: 'user',
            content: [
              'Compare the options and choose the best one.',
              `Input: ${options.input}`,
              `Options:\n${options.options.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
              options.criteria?.length ? `Criteria: ${options.criteria.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      },
      { chainOfThought: 'private' },
    ),
  );

  return { content: response.content, response, steps: [{ step: 'compare-and-decide', response }] };
}

function toRequestResponseFormat(format?: ResponseFormatConfig): RequestResponseFormat {
  if (!format || format.type === 'text') return undefined;
  return { type: format.type, schema: format.schema };
}
