import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { canWrite, parseDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import type { TurnInstructions, TurnPools, TurnSecrets } from "../thread/turnPool.ts";
import { driveOfProject } from "./contextProjects.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";

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

/** In a user's object: their current contexts and drives. */
export const layer = Layer.effect(
  ThreadContexts,
  Effect.gen(function* () {
    const drives = yield* UserDrives.UserDrives;
    const folders = yield* UserFolders.UserFolders;
    const directory = yield* Effect.serviceOption(DriveDirectory);
    return ThreadContexts.of({
      placeOfProject: (projectId) =>
        Effect.gen(function* () {
          const userId = yield* drives.userId;
          const driveId = userId === null ? null : driveOfProject(projectId, userId);
          const parsed = driveId === null ? null : parseDriveId(driveId);
          if (driveId === null || parsed === null) return null;
          // `access` also says whether the user is still in the drive's context.
          if (!canWrite(yield* drives.access(driveId))) return null;
          if (yield* folders.driveIsTrashed(driveId)) {
            return yield* Effect.fail(new ThreadFolderTrashedError());
          }
          // A My Drive is always its own home; any other drive says whether a remote is.
          const remote =
            parsed.kind !== "my" &&
            directory._tag === "Some" &&
            (yield* directory.value.forDrive(driveId).remote()) !== null;
          return { contextId: parsed.contextId, driveId, remote };
        }).pipe(Effect.catchTags({ SqlError: Effect.die, DriveObjectError: Effect.die })),
      turn: (threadId, projectId) =>
        folders.turn({ threadId, projectId }).pipe(
          Effect.catchTags({
            ThreadHomeTrashedError: () => Effect.fail(new ThreadFolderTrashedError()),
            SqlError: Effect.die,
          }),
        ),
    });
  }),
);

/** In the Worker, which only reads threads. Threads are created in their user's object. */
export const layerWorker = Layer.succeed(
  ThreadContexts,
  ThreadContexts.of({
    placeOfProject: () => Effect.die("Threads are created in their user's object."),
    turn: () => Effect.die("Turns start in their user's object."),
  }),
);
