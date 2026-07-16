import { z } from 'zod';
import type { CompletionRequest } from '../types/messages.js';
import type { SecurityFinding } from '../types/security.js';

const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageContentSchema = z.object({
  type: z.literal('image'),
  source: z.record(z.unknown()),
});

const audioContentSchema = z.object({
  type: z.literal('audio'),
  source: z.record(z.unknown()),
});

const videoContentSchema = z.object({
  type: z.literal('video'),
  source: z.record(z.unknown()),
});

const contentPartSchema = z.union([textContentSchema, imageContentSchema, audioContentSchema, videoContentSchema]);

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
});

const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()),
  execute: z.function().optional(),
});

export const completionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  tools: z.array(toolDefinitionSchema).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  userId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export class SchemaValidator {
  validate(request: CompletionRequest): SecurityFinding[] {
    const parsed = completionRequestSchema.safeParse(request);
    if (parsed.success) return [];

    return parsed.error.issues.map((issue) => ({
      type: 'schema',
      severity: 'high',
      message: issue.message,
      path: issue.path.join('.'),
    }));
  }
}
