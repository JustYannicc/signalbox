import type { CheckpointViews, DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import type { Oid } from "./git/gitObjects.ts";

/** Who is writing: a thread, on its machine of `generation`. */
export interface DriveWriter {
  readonly threadId: string;
  /** The thread's owner, whose role in the drive the write needs. */
  readonly userId: string;
  readonly generation: number;
  /** Whether the thread has a turn running. `main` only moves during one. */
  readonly live: boolean;
  /** The highest pack sequence the writer has; answers list only newer packs. */
  readonly packsAfter: number;
}

export interface ThreadRefs {
  readonly main: Oid | null;
  readonly thread: Oid | null;
  readonly wip: Oid | null;
  /** The thread's machine state (#490). */
  readonly machine: Oid | null;
  readonly base: Oid | null;
  readonly packs: ReadonlyArray<{
    readonly seq: number;
    readonly name: string;
    readonly size: number;
  }>;
  readonly remote: DriveRemote | null;
  /** Commits in `packs` whose parents are on the remote, not in the drive. */
  readonly shallow: ReadonlyArray<Oid>;
  /** Latest uploaded Git notes ref commit for this thread. */
  readonly notes?: Oid | null;
  /** Context and shortcut view pinned by a fork or restore. */
  readonly pinnedViews?: CheckpointViews | null;
  /** Changes on fork or restore so the Runner replaces a stale checkout. */
  readonly revision?: string | null;
}

export type RefWrite =
  | { readonly _tag: "ok"; readonly refs: ThreadRefs }
  | { readonly _tag: "conflict"; readonly refs: ThreadRefs }
  | { readonly _tag: "refused"; readonly reason: string };

export type CheckpointOperationResult =
  | { readonly _tag: "ok" | "conflict"; readonly refs: ThreadRefs; readonly generation: number }
  | { readonly _tag: "refused"; readonly reason: string; readonly generation?: number };

export interface ForkCheckpointRequest {
  readonly sourceThreadId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly operationId: string;
}

export interface RestoreCheckpointRequest {
  readonly threadId: string;
  readonly runId: string;
  /** Restore the turn's start or end. Omitted means end. */
  readonly boundary?: "start" | "end";
  readonly operationId: string;
  readonly expectedThread: Oid | null;
  readonly expectedWip: Oid | null;
  /** The generation the caller observed; the operation advances it by one. */
  readonly generation: number;
}

/** Internal recovery evidence. Never returns refs or bypasses public restore authorization. */
export type RestoreCheckpointStatus = "committed" | "not-committed" | "unverified";

export type ThreadFenceResult =
  | { readonly _tag: "ok"; readonly generation: number }
  | { readonly _tag: "missing" };

export interface UndoRestoreRequest {
  readonly threadId: string;
  readonly restoreOperationId: string;
  readonly operationId: string;
  readonly expectedThread: Oid | null;
  readonly expectedWip: Oid | null;
  /** The generation currently held by the thread; undo advances it by one. */
  readonly generation: number;
}

export interface UpdateToLatestRequest {
  readonly threadId: string;
  readonly operationId: string;
  readonly expectedThread: Oid | null;
  readonly expectedWip: Oid | null;
  readonly generation: number;
}
