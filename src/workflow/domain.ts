import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { WorkflowClient, WorkflowResult, WorkflowStepResult } from './chains.js';
import { withFactualDefaults } from '../hallucination/factual.js';

export interface DomainWorkflowOptions {
  model: string;
  input: string;
  context?: string[];
}

export interface SupportWorkflowOptions extends DomainWorkflowOptions {
  customerTier?: string;
}

export interface SalesWorkflowOptions extends DomainWorkflowOptions {
  product?: string;
}

export interface LegalReviewWorkflowOptions extends DomainWorkflowOptions {
  jurisdiction?: string;
}

export interface CodeReviewWorkflowOptions extends DomainWorkflowOptions {
  language?: string;
}

export async function supportTriageWorkflow(
  client: WorkflowClient,
  options: SupportWorkflowOptions,
): Promise<WorkflowResult> {
  return singleStepWorkflow(client, 'support-triage', {
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        'Triage this support request.',
        'Return severity, category, likely cause, next best action, and a customer-safe reply.',
        options.customerTier ? `Customer tier: ${options.customerTier}` : '',
        contextBlock(options.context),
        `Request:\n${options.input}`,
      ].filter(Boolean).join('\n\n'),
    }],
    responseFormat: {
      type: 'json_schema',
      schema: objectSchema(['severity', 'category', 'nextAction', 'reply']),
    },
  });
}

export async function salesQualificationWorkflow(
  client: WorkflowClient,
  options: SalesWorkflowOptions,
): Promise<WorkflowResult> {
  return singleStepWorkflow(client, 'sales-qualification', {
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        'Qualify this sales lead.',
        'Return fitScore, painPoints, objections, recommendedOffer, and followUpEmail.',
        options.product ? `Product: ${options.product}` : '',
        contextBlock(options.context),
        `Lead notes:\n${options.input}`,
      ].filter(Boolean).join('\n\n'),
    }],
    responseFormat: {
      type: 'json_schema',
      schema: objectSchema(['fitScore', 'painPoints', 'recommendedOffer', 'followUpEmail']),
    },
  });
}

export async function legalReviewWorkflow(
  client: WorkflowClient,
  options: LegalReviewWorkflowOptions,
): Promise<WorkflowResult> {
  return singleStepWorkflow(client, 'legal-review', withFactualDefaults({
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        'Review this text for legal risk. Do not provide legal advice.',
        'Return risks, missingClauses, suggestedQuestions, and safeSummary.',
        options.jurisdiction ? `Jurisdiction: ${options.jurisdiction}` : '',
        contextBlock(options.context),
        `Text:\n${options.input}`,
      ].filter(Boolean).join('\n\n'),
    }],
    responseFormat: {
      type: 'json_schema',
      schema: objectSchema(['risks', 'suggestedQuestions', 'safeSummary']),
    },
  }, { requireUnknownFallback: true, chainOfThought: 'private' }));
}

export async function codeReviewWorkflow(
  client: WorkflowClient,
  options: CodeReviewWorkflowOptions,
): Promise<WorkflowResult> {
  return singleStepWorkflow(client, 'code-review', {
    model: options.model,
    messages: [{
      role: 'user',
      content: [
        'Review this code for bugs, security risks, performance issues, and missing tests.',
        'Return findings ordered by severity with file/line references when available.',
        options.language ? `Language: ${options.language}` : '',
        contextBlock(options.context),
        `Code:\n${options.input}`,
      ].filter(Boolean).join('\n\n'),
    }],
    responseFormat: {
      type: 'json_schema',
      schema: objectSchema(['findings', 'riskLevel', 'testSuggestions']),
    },
  });
}

async function singleStepWorkflow(
  client: WorkflowClient,
  step: string,
  request: CompletionRequest,
): Promise<WorkflowResult> {
  const response = await client.complete(request);
  const steps: WorkflowStepResult[] = [{ step, response }];
  return {
    content: response.content,
    response,
    steps,
  };
}

function contextBlock(context?: string[]): string {
  return context?.length ? `Context:\n${context.map((item, index) => `[${index + 1}] ${item}`).join('\n')}` : '';
}

function objectSchema(required: string[]): Record<string, unknown> {
  return {
    type: 'object',
    required,
    properties: Object.fromEntries(required.map((key) => [key, {}])),
  };
}
