import type {
  ChannelSchema,
  GraphCheckpoint,
  GraphCheckpointV1,
  GraphTask,
  PendingInterrupt,
  StoredGraphCheckpoint,
} from '../types/graph.js';

/**
 * The 2.0 checkpoint schema under the name 1.25 gave it, so code written against 1.25 compiles.
 *
 * @deprecated Use `GraphCheckpoint`, which is this schema in 2.0.
 */
export type GraphCheckpointV2<S extends ChannelSchema = ChannelSchema> = GraphCheckpoint<S>;

/**
 * Reads a checkpoint in the current schema from one in either schema. A custom checkpointer whose
 * store still holds 1.x checkpoints can return them as they are, since the graph calls this on every
 * read; a tool that reads a store directly calls it too. A version 2 checkpoint is returned as it is.
 *
 * A version 1 checkpoint gains its id, its tasks spelled out from `next` when it carried none, and its
 * questions moved from the single `interrupt` into `interrupts`.
 */
export function migrateCheckpoint<S extends ChannelSchema = ChannelSchema>(
  checkpoint: StoredGraphCheckpoint<S>,
): GraphCheckpoint<S> {
  if (checkpoint.version === 2) return checkpoint;
  return toCheckpoint(checkpoint);
}

/** A checkpoint being assembled, before `toCheckpoint()` fills in its id, tasks, and questions. */
export type CheckpointDraft<S extends ChannelSchema = ChannelSchema> = Omit<
  GraphCheckpoint<S>,
  'version' | 'id' | 'tasks' | 'interrupts'
> & {
  version?: 2;
  id?: string;
  tasks?: GraphTask[];
  interrupts?: PendingInterrupt[];
};

/**
 * Turns a draft or a stored checkpoint of either schema into one in the current schema. The id is
 * always derived again, so a checkpoint copied to another thread or step never keeps a stale one.
 */
export function toCheckpoint<S extends ChannelSchema = ChannelSchema>(
  draft: CheckpointDraft<S> | GraphCheckpointV1<S>,
): GraphCheckpoint<S> {
  const { version: _version, id: _id, tasks, interrupts, ...rest } = draft as CheckpointDraft<S>;
  const { interrupt, ...fields } = rest as typeof rest & { interrupt?: PendingInterrupt };
  return {
    version: 2,
    id: `${fields.threadId}:${fields.step}`,
    ...fields,
    // Without explicit tasks, each node in `next` is one task whose id is the node's name.
    tasks: tasks ?? fields.next.map((node) => ({ id: node, node })),
    interrupts: interrupts ?? (interrupt ? [interrupt] : []),
  };
}
