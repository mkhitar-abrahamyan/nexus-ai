import type { ChannelSchema, GraphCheckpoint, GraphTask, PendingInterrupt } from '../types/graph.js';

/**
 * A checkpoint in the 2.0 schema. Every checkpoint has an id and its pending tasks, and its questions
 * are only in `interrupts`. Checkpointers write version 1 throughout 1.x and keep reading it
 * throughout 2.x; this is the shape `migrateCheckpoint()` produces from either.
 */
export interface GraphCheckpointV2<S extends ChannelSchema = ChannelSchema>
  extends Omit<GraphCheckpoint<S>, 'interrupt' | 'interrupts' | 'tasks'> {
  /** The schema version. */
  version: 2;
  /** The checkpoint's id: the thread and the step, as `<threadId>:<step>`. */
  id: string;
  /** Tasks to run next, always present, one per node or `Send`. Empty when the run is finished. */
  tasks: GraphTask[];
  /** Every pending question, empty when the run is not waiting for input. */
  interrupts: PendingInterrupt[];
}

/**
 * Reads a checkpoint in the 2.0 schema from one in either schema, so code written against 2.0 can
 * read what a 1.x checkpointer stored. A version 2 checkpoint is returned as it is.
 *
 * A version 1 checkpoint gains its id, its tasks spelled out from `next` when it carried none, and its
 * questions moved from the single `interrupt` into `interrupts`.
 */
export function migrateCheckpoint<S extends ChannelSchema = ChannelSchema>(
  checkpoint: GraphCheckpoint<S> | GraphCheckpointV2<S>,
): GraphCheckpointV2<S> {
  if ((checkpoint as GraphCheckpointV2<S>).version === 2) return checkpoint as GraphCheckpointV2<S>;
  const { interrupt, interrupts, tasks, ...rest } = checkpoint as GraphCheckpoint<S>;
  return {
    ...rest,
    version: 2,
    id: `${checkpoint.threadId}:${checkpoint.step}`,
    // Without explicit tasks, each node in `next` is one task whose id is the node's name.
    tasks: tasks ?? checkpoint.next.map((node) => ({ id: node, node })),
    interrupts: interrupts ?? (interrupt ? [interrupt] : []),
  };
}
