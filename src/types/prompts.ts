/**
 * Prompt versioning: templates, content-addressed versions, labels, and promotion.
 *
 * A prompt is data that ships like code. Versions are derived from their content, so the same
 * template is the same version everywhere; labels such as `production` or `staging` point at a
 * version and move by promotion, which gates can refuse; and every move is recorded, so history,
 * diffs, and rollback need nothing beyond the store.
 */

import type { CompletionRequest, Message } from './messages.js';

/** One message of a prompt template, whose content may contain `{{variable}}` and `{{> partial}}`. */
export interface PromptMessageTemplate {
  /** Who the message is from. */
  role: 'system' | 'user' | 'assistant';
  /** The template text. */
  content: string;
  /** Participant name, passed through to the rendered message. */
  name?: string;
}

/**
 * A slot filled with whole messages at render time, such as the conversation so far.
 *
 * The variable of the same name must be an array of messages, or be absent when `optional` is set.
 */
export interface PromptMessagePlaceholder {
  /** The variable that holds the messages. */
  placeholder: string;
  /** Renders nothing when the variable is absent, instead of failing. */
  optional?: boolean;
}

/** A message template or a placeholder for messages. */
export type PromptMessage = PromptMessageTemplate | PromptMessagePlaceholder;

/**
 * Request settings versioned with the prompt: model, temperature, output format, tools, and any
 * other completion field except the messages the template renders.
 */
export type PromptModelConfig = Partial<Omit<CompletionRequest, 'messages'>>;

/** Everything that defines a prompt. Two definitions with the same content are the same version. */
export interface PromptDefinition {
  /** The prompt's name, which identifies it in a registry. */
  name: string;
  /** The messages it renders, in order. */
  messages: PromptMessage[];
  /** Named fragments that templates include with `{{> name}}`. */
  partials?: Record<string, string>;
  /** Request settings versioned with the prompt. */
  config?: PromptModelConfig;
  /** Values used for variables the caller does not supply. */
  defaults?: Record<string, unknown>;
  /** Application data, such as a description or an owner. Not part of the version. */
  metadata?: Record<string, unknown>;
}

/** A committed prompt: a definition with its content version and where it came from. */
export interface PromptVersion extends PromptDefinition {
  /** Content version, such as `p3f9a1c0b7e2d`. The same content always has the same version. */
  version: string;
  /** Every variable the templates and placeholders use, sorted. */
  variables: string[];
  /** ISO-8601 time the version was first committed. */
  createdAt: string;
  /** What changed, like a commit message. */
  message?: string;
  /** Who committed it. */
  author?: string;
  /** The version that was newest before this one. */
  parent?: string;
}

/** One arm of an A/B split. */
export interface PromptVariant {
  /** The version it serves. */
  version: string;
  /** Its relative share of traffic. */
  weight: number;
}

/** A label, such as `production` or `staging`, pointing at a version or splitting traffic between several. */
export interface PromptLabel {
  /** The prompt. */
  name: string;
  /** The label. */
  label: string;
  /** The version it serves, or the control arm when `variants` is set. */
  version: string;
  /** Traffic split between versions. Absent means every request gets `version`. */
  variants?: PromptVariant[];
  /** ISO-8601 time it last moved. */
  updatedAt: string;
  /** Who moved it. */
  by?: string;
}

/** What happened to a prompt, as recorded in its history. */
export type PromptHistoryAction = 'commit' | 'label' | 'unlabel' | 'promote' | 'rollback' | 'split';

/** One recorded change to a prompt. */
export interface PromptHistoryEntry {
  /** The prompt. */
  name: string;
  /** What happened. */
  action: PromptHistoryAction;
  /** The version committed, or the version a label now points at. */
  version?: string;
  /** The label that moved, for label changes. */
  label?: string;
  /** The version the label pointed at before, when it existed. */
  previous?: string;
  /** The label promoted from, for a promotion. */
  from?: string;
  /** The split that was set, for `split`. */
  variants?: PromptVariant[];
  /** Who made the change. */
  by?: string;
  /** Why. */
  note?: string;
  /** ISO-8601 time of the change. */
  at: string;
}

/**
 * Where prompt versions, labels, and history live.
 *
 * Methods may be synchronous or asynchronous. Versions are immutable and keyed by content, so saving
 * one twice is harmless; labels are the only mutable state, and `setLabel` compares before it writes.
 */
export interface PromptStore {
  /** Stores a version. Saving one that exists already leaves the stored copy unchanged. */
  saveVersion(version: PromptVersion): Promise<void> | void;
  /** Reads a version. */
  getVersion(name: string, version: string): Promise<PromptVersion | undefined> | PromptVersion | undefined;
  /** Versions of a prompt, newest first. */
  listVersions(name: string, options?: { limit?: number }): Promise<PromptVersion[]> | PromptVersion[];
  /** Reads a label. */
  getLabel(name: string, label: string): Promise<PromptLabel | undefined> | PromptLabel | undefined;
  /** Every label of a prompt. */
  listLabels(name: string): Promise<PromptLabel[]> | PromptLabel[];
  /**
   * Writes a label when it still points at `expected`: a version, `null` for a label that must not
   * exist yet, or `undefined` to write unconditionally. Resolves false when another writer got there
   * first.
   */
  setLabel(label: PromptLabel, expected?: string | null): Promise<boolean> | boolean;
  /** Removes a label. Resolves true when it existed. */
  deleteLabel(name: string, label: string): Promise<boolean> | boolean;
  /** Records a change. */
  appendHistory(entry: PromptHistoryEntry): Promise<void> | void;
  /** A prompt's history, newest first, optionally for one label. */
  listHistory(
    name: string,
    options?: { label?: string; limit?: number },
  ): Promise<PromptHistoryEntry[]> | PromptHistoryEntry[];
  /** Every prompt name, sorted. */
  listNames(): Promise<string[]> | string[];
}

/** The rendered request, with the prompt it came from recorded in `metadata.prompt`. */
export type RenderedPrompt = CompletionRequest & {
  /** Application data, including `prompt`: the name, version, label, and variant rendered. */
  metadata: Record<string, unknown> & { prompt: PromptReference };
};

/** Which prompt a request was rendered from, as recorded on the request and in traces. */
export interface PromptReference {
  /** The prompt's name. */
  name: string;
  /** Its content version, when it came from a registry or was versioned locally. */
  version?: string;
  /** The label it was served through. */
  label?: string;
  /** Index of the A/B arm served, when the label splits traffic. */
  variant?: number;
}

/** Options for rendering a prompt. */
export interface RenderOptions {
  /** Request fields that override the prompt's own configuration, such as a different model. */
  overrides?: Partial<CompletionRequest>;
  /** Model used when neither the prompt nor `overrides` names one. Defaults to `auto`. */
  model?: string;
  /**
   * What a missing variable does: `error` throws, the default; `empty` renders an empty string;
   * `keep` leaves the placeholder text in place.
   */
  missing?: 'error' | 'empty' | 'keep';
}

/** A message placeholder's content, as the variable must supply it. */
export type PlaceholderMessages = Message[];
