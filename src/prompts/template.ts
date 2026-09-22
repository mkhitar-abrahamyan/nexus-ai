import type { Message } from '../types/messages.js';
import type {
  PromptDefinition,
  PromptMessage,
  PromptMessageTemplate,
  PromptModelConfig,
  PromptReference,
  RenderedPrompt,
  RenderOptions,
} from '../types/prompts.js';
import { PromptDefinitionError, PromptRenderError } from './errors.js';
import { promptVersion } from './version.js';

type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer R} ` ? Trim<R> : S;
type Head<S extends string> = S extends `${infer H}.${string}` ? H : S;
type NameOf<B extends string> = Trim<B> extends `>${string}` ? never : Head<Trim<B>>;

/**
 * The variables a template string uses, as a union of names: `'topic' | 'user'` for
 * `"Write about {{topic}} for {{user.name}}"`. A string that is not a literal gives `string`.
 */
export type TemplateVariables<S extends string, Acc extends string = never> = string extends S
  ? string
  : S extends `${string}{{${infer B}}}${infer R}`
    ? TemplateVariables<R, Acc | NameOf<B>>
    : Acc;

/**
 * What `render()` takes for a prompt with variables `V`, placeholders `H`, and defaults `D`:
 * every variable without a default is required, and placeholders take arrays of messages.
 */
export type PromptInput<V extends string, H extends string = never, D extends string = never> = string extends V
  ? Record<string, unknown>
  : { [K in Exclude<V, D | H>]: unknown } & { [K in D]?: unknown } & { [K in H]?: Message[] };

type RenderArgs<V extends string, H extends string, D extends string> = [Exclude<V, D | H>] extends [never]
  ? [variables?: PromptInput<V, H, D>, options?: RenderOptions]
  : [variables: PromptInput<V, H, D>, options?: RenderOptions];

/** A defined prompt, compiled once and rendered many times. */
export interface Prompt<V extends string = string, H extends string = never, D extends string = never> {
  /** The prompt's name. */
  readonly name: string;
  /** The definition it was built from, which is what a registry commits. */
  readonly definition: PromptDefinition;
  /** Every variable its templates and placeholders use, sorted. */
  readonly variables: readonly string[];
  /** Renders a completion request. Throws `PromptRenderError` for missing variables unless told otherwise. */
  render(...args: RenderArgs<V, H, D>): RenderedPrompt;
  /** The content version a registry would assign this definition. */
  version(): Promise<string>;
}

/** The input `definePrompt()` infers variable names from. */
export interface PromptSpec<C extends string, H extends string, P extends string, D extends string> {
  /** The prompt's name, which identifies it in a registry. */
  name: string;
  /** The messages it renders: templates, and placeholders for whole messages. */
  messages: ReadonlyArray<
    { role: PromptMessageTemplate['role']; content: C; name?: string } | { placeholder: H; optional?: boolean }
  >;
  /** Named fragments included with `{{> name}}`. */
  partials?: Record<string, P>;
  /** Request settings versioned with the prompt. */
  config?: PromptModelConfig;
  /** Values for variables the caller may leave out. */
  defaults?: { [K in D]: unknown };
  /** Application data. Not part of the version. */
  metadata?: Record<string, unknown>;
}

type Segment = string | { path: string[] };

/** A message template reduced to text and variable lookups, with partials already inlined. */
export type CompiledMessage =
  | { role: PromptMessageTemplate['role']; name?: string; segments: Segment[] }
  | { placeholder: string; optional: boolean };

/** A definition compiled for rendering. */
export interface CompiledPrompt {
  /** The compiled messages. */
  messages: CompiledMessage[];
  /** Every variable used, sorted. */
  variables: string[];
}

const TAG = /\{\{\s*(>?)\s*([^{}]*?)\s*\}\}/g;
const NAME = /^[A-Za-z_$][\w$-]*(\.[A-Za-z_$][\w$-]*)*$/;

/**
 * Compiles a definition: parses every template, inlines partials, and lists the variables.
 *
 * Throws `PromptDefinitionError` for an unknown partial, a partial that includes itself, or a tag
 * that is not a variable name.
 */
export function compilePrompt(definition: PromptDefinition): CompiledPrompt {
  const variables = new Set<string>();
  const partials = definition.partials ?? {};

  const parse = (text: string, stack: readonly string[]): Segment[] => {
    const out: Segment[] = [];
    let last = 0;
    for (const match of text.matchAll(TAG)) {
      const [whole, partial, body] = match as unknown as [string, string, string];
      const index = match.index as number;
      if (index > last) pushText(out, text.slice(last, index));
      last = index + whole.length;
      if (partial) {
        if (!Object.hasOwn(partials, body)) {
          throw new PromptDefinitionError(`Prompt "${definition.name}" includes unknown partial "${body}"`);
        }
        if (stack.includes(body)) {
          throw new PromptDefinitionError(
            `Prompt "${definition.name}" has a partial cycle: ${[...stack, body].join(' > ')}`,
          );
        }
        for (const segment of parse(partials[body] as string, [...stack, body])) {
          if (typeof segment === 'string') pushText(out, segment);
          else out.push(segment);
        }
        continue;
      }
      if (!NAME.test(body)) {
        throw new PromptDefinitionError(`Prompt "${definition.name}" has an invalid tag "${whole}"`);
      }
      const path = body.split('.');
      variables.add(path[0] as string);
      out.push({ path });
    }
    if (last < text.length) pushText(out, text.slice(last));
    return out;
  };

  const messages = definition.messages.map((message: PromptMessage): CompiledMessage => {
    if ('placeholder' in message) {
      if (!NAME.test(message.placeholder) || message.placeholder.includes('.')) {
        throw new PromptDefinitionError(
          `Prompt "${definition.name}" has an invalid placeholder "${message.placeholder}"`,
        );
      }
      variables.add(message.placeholder);
      return { placeholder: message.placeholder, optional: message.optional === true };
    }
    return {
      role: message.role,
      ...(message.name === undefined ? {} : { name: message.name }),
      segments: parse(message.content, []),
    };
  });

  return { messages, variables: [...variables].sort() };
}

function pushText(out: Segment[], text: string): void {
  const previous = out[out.length - 1];
  if (typeof previous === 'string') out[out.length - 1] = previous + text;
  else out.push(text);
}

function lookup(variables: Record<string, unknown>, defaults: Record<string, unknown>, path: string[]): unknown {
  const head = path[0] as string;
  let value = variables[head] === undefined ? defaults[head] : variables[head];
  for (let index = 1; index < path.length && value != null; index += 1) {
    value = (value as Record<string, unknown>)[path[index] as string];
  }
  return value;
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

/** Renders a compiled prompt into a completion request, recording `reference` in `metadata.prompt`. */
export function renderCompiled(
  compiled: CompiledPrompt,
  definition: PromptDefinition,
  variables: Record<string, unknown> = {},
  reference: PromptReference = { name: definition.name },
  options: RenderOptions = {},
): RenderedPrompt {
  const defaults = definition.defaults ?? {};
  const policy = options.missing ?? 'error';
  const missing: string[] = [];
  const messages: Message[] = [];

  for (const message of compiled.messages) {
    if ('placeholder' in message) {
      const value = lookup(variables, defaults, [message.placeholder]);
      if (value == null) {
        if (!message.optional) missing.push(message.placeholder);
        continue;
      }
      if (!Array.isArray(value)) {
        throw new PromptDefinitionError(
          `Placeholder "${message.placeholder}" of prompt "${definition.name}" needs an array of messages`,
        );
      }
      messages.push(...(value as Message[]));
      continue;
    }

    let content = '';
    for (const segment of message.segments) {
      if (typeof segment === 'string') {
        content += segment;
        continue;
      }
      const value = lookup(variables, defaults, segment.path);
      if (value == null) {
        const name = segment.path.join('.');
        if (policy === 'error') missing.push(name);
        else if (policy === 'keep') content += `{{${name}}}`;
        continue;
      }
      content += format(value);
    }
    messages.push(
      message.name === undefined
        ? { role: message.role, content }
        : { role: message.role, content, name: message.name },
    );
  }

  if (missing.length > 0) throw new PromptRenderError(definition.name, [...new Set(missing)]);

  const config = definition.config ?? {};
  const overrides = options.overrides ?? {};
  return {
    ...config,
    ...overrides,
    model: overrides.model ?? config.model ?? options.model ?? 'auto',
    messages,
    metadata: { ...config.metadata, ...overrides.metadata, prompt: reference },
  } as RenderedPrompt;
}

/**
 * Defines a prompt, typing its variables from the template text.
 *
 * `render()` then requires every variable without a default, and the prompt can be committed to a
 * registry as it is. Templates use `{{name}}` and `{{name.path}}` for values and `{{> partial}}` for
 * named fragments; objects are rendered as JSON. There is no escape syntax: to render a literal
 * `{{`, pass it in through a variable.
 *
 * @example
 * ```ts
 * const summarize = definePrompt({
 *   name: 'summarize',
 *   messages: [
 *     { role: 'system', content: 'You summarize {{kind}} for {{audience}}.' },
 *     { placeholder: 'history', optional: true },
 *     { role: 'user', content: '{{text}}' },
 *   ],
 *   defaults: { audience: 'engineers' },
 *   config: { model: 'gpt-5.4-mini', temperature: 0 },
 * });
 * const request = summarize.render({ kind: 'incident reports', text });
 * ```
 */
export function definePrompt<
  C extends string,
  H extends string = never,
  P extends string = never,
  D extends string = never,
>(spec: PromptSpec<C, H, P, D>): Prompt<TemplateVariables<C> | TemplateVariables<P> | H, H, D> {
  const definition = spec as unknown as PromptDefinition;
  if (!definition.name?.trim()) throw new PromptDefinitionError('A prompt needs a name');
  const compiled = compilePrompt(definition);
  let version: Promise<string> | undefined;

  return {
    name: definition.name,
    definition,
    variables: compiled.variables,
    render: ((variables?: Record<string, unknown>, options?: RenderOptions) =>
      renderCompiled(compiled, definition, variables, { name: definition.name }, options)) as never,
    version: () => {
      version ??= promptVersion(definition);
      return version;
    },
  };
}
