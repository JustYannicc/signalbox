import type { ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { TurnInstructions, TurnPools, TurnSecrets } from "../thread/turnPool.ts";

/** Where a new thread works: the drive it changes files in, and the context it acts as. */
export interface ThreadPlace {
  readonly contextId: SignalboxContextId;
  readonly driveId: string;
  /** Whether the drive is backed by a remote repository, so each thread works on its own branch. */
  readonly remote: boolean;
}

/** What a thread's next turn runs on and follows, from its home's chain. */
export interface ThreadTurn {
  readonly pools: TurnPools;
  readonly instructions: TurnInstructions;
  readonly secrets: TurnSecrets;
}

/** A thread's home is hidden, so the user needs to restore it before a turn can start. */
export class ThreadFolderTrashedError extends Schema.TaggedError<ThreadFolderTrashedError>()(
  "ThreadFolderTrashedError",
  {},
) {
  override get message(): string {
    return "This thread's folder is in Trash.";
  }
}

/**
 * What `CloudThreadService` needs to know about the user's tree: where a new
 * thread works, and what its turns run on and follow.
 */
export class ThreadContexts extends Context.Service<
  ThreadContexts,
  {
    /**
     * The drive a thread started in `projectId` works in and the context it
     * acts as, or null when the project is none of the acting user's or they
     * can't change files in its drive.
     */
    readonly placeOfProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ThreadPlace | null, ThreadFolderTrashedError>;
    readonly initialModelSelection: (
      projectId: ProjectId | null,
      threadId?: ThreadId,
    ) => Effect.Effect<ModelSelection | null, ThreadFolderTrashedError>;
    /**
     * The thread's turn now, resolved from its home's chain (`folderTree.ts`).
     * `projectId`: the thread's, when the caller knows it (a create does).
     */
    readonly turn: (
      threadId: ThreadId,
      projectId: ProjectId | null,
    ) => Effect.Effect<ThreadTurn, ThreadFolderTrashedError>;
  }
>()("@signalbox/cloud/user/threadContexts") {}
