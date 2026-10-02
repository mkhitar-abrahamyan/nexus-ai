import type { ErrorObject, ValidateFunction } from 'ajv';
import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { ResponseFormatConfig } from '../types/config.js';

/** Raised when a response does not match the requested format and cannot be repaired. */
export class ResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseFormatError';
  }
}

/** The part of a zod schema this module calls. Any version with `safeParse` fits. */
interface SafeParser {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues?: Array<{ path?: Array<string | number>; message: string }>; message?: string };
  };
}

/** What `compile()` needs from an ajv instance. */
interface SchemaCompiler {
  compile(schema: Record<string, unknown>): ValidateFunction;
}

let compiler: Promise<SchemaCompiler> | undefined;
const compiledSchemas = new WeakMap<Record<string, unknown>, ValidateFunction>();

/**
 * Checks a response against the requested format. A zod shape is checked through its own
 * `safeParse`, so it needs nothing installed beyond the zod that built it; a JSON Schema loads `ajv`
 * and `ajv-formats` on first use.
 */
export async function applyResponseFormat(
  response: NexusResponse,
  config?: ResponseFormatConfig,
): Promise<NexusResponse> {
  if (!config || config.type === 'text') return response;

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    throw new ResponseFormatError('Expected model output to be valid JSON');
  }

  if (config.type === 'json_schema' && config.schema) {
    if (isZodShape(config.schema)) {
      const problems = zodShapeProblems(config.schema as Record<string, unknown>, parsed);
      if (problems.length > 0) {
        throw new ResponseFormatError(`Model output failed JSON schema validation: ${problems.join('; ')}`);
      }
    } else {
      const validate = await compileJsonSchema(config.schema);
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

/**
 * Checks each field of a zod shape the way `z.object(shape).passthrough()` would: every declared
 * field through its own schema, and any other field allowed.
 */
function zodShapeProblems(shape: Record<string, unknown>, value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['$ must be an object'];
  const problems: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    if (!field || typeof (field as SafeParser).safeParse !== 'function') continue;
    const result = (field as SafeParser).safeParse((value as Record<string, unknown>)[key]);
    if (result.success) continue;
    const issues = result.error?.issues ?? [{ message: result.error?.message ?? 'is invalid' }];
    for (const issue of issues) {
      const path = ['$', key, ...(issue.path ?? [])].join('.');
      problems.push(`${path} ${issue.message}`);
    }
  }
  return problems;
}

async function compileJsonSchema(schema: Record<string, unknown>): Promise<ValidateFunction> {
  const cached = compiledSchemas.get(schema);
  if (cached) return cached;

  const ajv = await loadCompiler();
  try {
    const validate = ajv.compile(schema);
    compiledSchemas.set(schema, validate);
    return validate;
  } catch (error) {
    throw new ResponseFormatError(`Invalid JSON schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Loads ajv and its formats once, the first time a JSON Schema has to be checked. */
function loadCompiler(): Promise<SchemaCompiler> {
  compiler ??= (async () => {
    try {
      const [ajvModule, formatsModule] = await Promise.all([import('ajv'), import('ajv-formats')]);
      const Ajv = (ajvModule.default ?? ajvModule.Ajv) as unknown as new (
        options: Record<string, unknown>,
      ) => SchemaCompiler;
      const addFormats = formatsModule.default as unknown as (ajv: SchemaCompiler) => void;
      const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
      addFormats(ajv);
      return ajv;
    } catch (error) {
      compiler = undefined;
      throw new ResponseFormatError(
        `Checking a response against a JSON Schema needs ajv and ajv-formats, which are optional: run "npm install ajv ajv-formats", or pass a zod shape instead (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  })();
  return compiler;
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
