import { z } from 'zod';
import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { ResponseFormatConfig } from '../types/config.js';

export class ResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseFormatError';
  }
}

export function applyResponseFormat(response: NexusResponse, config?: ResponseFormatConfig): NexusResponse {
  if (!config || config.type === 'text') return response;

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    throw new ResponseFormatError('Expected model output to be valid JSON');
  }

  if (config.type === 'json_schema' && config.schema) {
    if (isZodShape(config.schema)) {
      const schema = z.object(config.schema as Record<string, z.ZodTypeAny>).passthrough();
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new ResponseFormatError(`Model output failed JSON schema validation: ${result.error.message}`);
      }
    } else {
      const errors = validateJsonSchemaLike(parsed, config.schema);
      if (errors.length) {
        throw new ResponseFormatError(`Model output failed JSON schema validation: ${errors.join('; ')}`);
      }
    }
  }

  return response;
}

export function withResponseFormat(request: CompletionRequest, config?: ResponseFormatConfig): CompletionRequest {
  const responseFormat = request.responseFormat || config;
  if (!responseFormat || responseFormat.type === 'text') return request;
  const requestResponseFormat: CompletionRequest['responseFormat'] = {
    type: responseFormat.type,
    schema: responseFormat.schema,
  };

  const schemaInstruction = responseFormat.type === 'json_schema' && responseFormat.schema
    ? `The JSON must match this schema description: ${JSON.stringify(responseFormat.schema)}`
    : 'Use a stable object shape with explicit keys.';

  const systemMessage: Message = {
    role: 'system',
    content: [
      'Return only valid JSON.',
      'Do not include markdown, prose, comments, or code fences.',
      'If a value is unknown, use null or an explicit "unknown" value instead of inventing facts.',
      schemaInstruction,
    ].join('\n'),
  };

  return {
    ...request,
    temperature: request.temperature ?? 0,
    topP: request.topP ?? 0.1,
    responseFormat: requestResponseFormat,
    messages: [systemMessage, ...request.messages],
  };
}

function isZodShape(schema: Record<string, unknown>): boolean {
  return Object.values(schema).some((value) => {
    return Boolean(value && typeof value === 'object' && 'safeParse' in value);
  });
}

function validateJsonSchemaLike(value: unknown, schema: Record<string, unknown>, path = '$'): string[] {
  const errors: string[] = [];
  const type = schema.type;

  if (typeof type === 'string' && !matchesJsonType(value, type)) {
    errors.push(`${path} expected ${type}`);
    return errors;
  }

  if (type === 'object' || schema.properties) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} expected object`);
      return errors;
    }

    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in objectValue)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties as Record<string, unknown>)) {
        if (key in objectValue && childSchema && typeof childSchema === 'object' && !Array.isArray(childSchema)) {
          errors.push(...validateJsonSchemaLike(
            objectValue[key],
            childSchema as Record<string, unknown>,
            `${path}.${key}`,
          ));
        }
      }
    }
  }

  if (type === 'array' && Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchemaLike(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
    });
  }

  return errors;
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return Boolean(value && typeof value === 'object' && !Array.isArray(value));
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && (type === 'number' || Number.isInteger(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}
