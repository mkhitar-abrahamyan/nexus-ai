import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { ResponseFormatConfig } from '../types/config.js';
import { withFactualDefaults } from '../hallucination/factual.js';
import { withRagContext, type RagChunk } from '../hallucination/rag.js';
import { completeVerified, type VerificationOptions } from '../hallucination/verification.js';

export interface WorkflowClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export interface WorkflowStepResult {
  step: string;
  response: NexusResponse;
}

export interface WorkflowResult {
  content: string;
  response: NexusResponse;
  steps: WorkflowStepResult[];
}

export interface SummarizeVerifyFormatOptions {
  model: string;
  input: string;
  verifyContext?: string[];
  responseFormat?: ResponseFormatConfig;
  summaryInstruction?: string;
  finalInstruction?: string;
}

export interface RagAnswerOptions {
  model: string;
  question: string;
  chunks: RagChunk[];
  verify?: boolean;
}

export interface ExtractStructuredOptions {
  model: string;
  input: string;
  schema: Record<string, unknown>;
  instruction?: string;
}

export interface ClassifyRouteOptions {
  model: string;
  input: string;
  labels: string[];
  instruction?: string;
}

export interface CompareOptions {
  model: string;
  input: string;
  options: string[];
  criteria?: string[];
}

type RequestResponseFormat = CompletionRequest['responseFormat'];

export async function summarizeVerifyFormat(
  client: WorkflowClient,
  options: SummarizeVerifyFormatOptions,
): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  const summary = await client.complete(withFactualDefaults({
    model: options.model,
    messages: [
      { role: 'user', content: `${options.summaryInstruction || 'Summarize the following content clearly.'}\n\n${options.input}` },
    ],
  }, { chainOfThought: 'private' }));
  steps.push({ step: 'summarize', response: summary });

  const verified = options.verifyContext?.length
    ? await completeVerified(client, {
      model: options.model,
      messages: [{ role: 'user', content: summary.content }],
      responseFormat: toRequestResponseFormat(options.responseFormat),
    }, {
      context: options.verifyContext,
      repair: true,
    } satisfies VerificationOptions)
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

export async function ragAnswer(client: WorkflowClient, options: RagAnswerOptions): Promise<WorkflowResult> {
  const request = withRagContext({
    model: options.model,
    messages: [{ role: 'user', content: options.question }],
  }, {
    chunks: options.chunks,
    requireCitations: true,
  });

  const response = options.verify
    ? await completeVerified(client, request, { context: options.chunks.map((chunk) => chunk.content), repair: true })
    : await client.complete(request);

  return {
    content: response.content,
    response,
    steps: [{ step: 'rag-answer', response }],
  };
}

export async function extractStructured(client: WorkflowClient, options: ExtractStructuredOptions): Promise<WorkflowResult> {
  const response = await client.complete({
    model: options.model,
    messages: [{
      role: 'user',
      content: `${options.instruction || 'Extract the requested structured data from the input.'}\n\n${options.input}`,
    }],
    responseFormat: {
      type: 'json_schema',
      schema: options.schema,
    },
  });

  return { content: response.content, response, steps: [{ step: 'extract-structured', response }] };
}

export async function classifyRoute(client: WorkflowClient, options: ClassifyRouteOptions): Promise<WorkflowResult> {
  const response = await client.complete({
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        options.instruction || 'Classify the input into exactly one label.',
        `Labels: ${options.labels.join(', ')}`,
        `Input: ${options.input}`,
      ].join('\n'),
    }],
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

export async function compareAndDecide(client: WorkflowClient, options: CompareOptions): Promise<WorkflowResult> {
  const response = await client.complete(withFactualDefaults({
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        'Compare the options and choose the best one.',
        `Input: ${options.input}`,
        `Options:\n${options.options.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
        options.criteria?.length ? `Criteria: ${options.criteria.join(', ')}` : '',
      ].filter(Boolean).join('\n\n'),
    }],
  }, { chainOfThought: 'private' }));

  return { content: response.content, response, steps: [{ step: 'compare-and-decide', response }] };
}

function toRequestResponseFormat(format?: ResponseFormatConfig): RequestResponseFormat {
  if (!format || format.type === 'text') return undefined;
  return { type: format.type, schema: format.schema };
}
