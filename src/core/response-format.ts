import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
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

const jsonSchemaValidator = new Ajv({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
const addFormats = addFormatsModule as unknown as FormatsPlugin;
addFormats(jsonSchemaValidator);
const compiledSchemas = new WeakMap<Record<string, unknown>, ValidateFunction>();

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
      const validate = compileJsonSchema(config.schema);
      if (!validate(parsed)) {
        throw new ResponseFormatError(
          `Model output failed JSON schema validation: ${formatJsonSchemaErrors(validate.errors)}`,
        );
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

  const schemaInstruction =
    responseFormat.type === 'json_schema' && responseFormat.schema
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

function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  const cached = compiledSchemas.get(schema);
  if (cached) return cached;

  try {
    const validate = jsonSchemaValidator.compile(schema);
    compiledSchemas.set(schema, validate);
    return validate;
  } catch (error) {
    throw new ResponseFormatError(`Invalid JSON schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatJsonSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'schema validation failed';
  return errors
    .map((error) => {
      const path = error.instancePath ? `$${error.instancePath}` : '$';
      return `${path} ${error.message || error.keyword}`;
    })
    .join('; ');
}
