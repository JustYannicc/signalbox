import { type OrchestrationV2ThreadProjection, type ThreadId } from "@t3tools/contracts";
import { runtimeModeWithin } from "@signalbox/automations/access";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CloudThreadService } from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { contextOfProject } from "../user/contextProjects.ts";
import { homeOf } from "../user/folderTree.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { UserFolders } from "../user/UserFolders.ts";
import { CollaborationError } from "./errors.ts";

export const refuse = (message: string, code: CollaborationError["code"] = "invalid_request") =>
  Effect.fail(new CollaborationError({ code, message }));

const isFailure = Schema.is(CollaborationError);
export const collaborationFailure = (cause: {
  readonly _tag: string;
  readonly message: string;
}) => {
  if (isFailure(cause)) return cause;
  return new CollaborationError({
    code:
      cause._tag === "ThreadNotFoundError" ||
      (cause._tag === "ThreadInboxError" && "code" in cause && cause.code === "not_found")
        ? "thread_not_found"
        : "orchestration_error",
    message:
      cause._tag === "ThreadNotFoundError"
        ? "Thread not found."
        : cause._tag === "ThreadCommandRejectedError" || cause._tag === "FolderRefusedError"
          ? "The thread refused the request."
          : "Cloud threads are unavailable right now. Try again.",
    cause,
  });
};

export const makeAccess = Effect.gen(function* () {
  const threads = yield* CloudThreadService;
  const drives = yield* UserDrives;
  const folders = yield* UserFolders;

  const source = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const userId = yield* drives.userId;
      if (userId === null) return yield* refuse("Thread not found.", "thread_not_found");
      const actor: Actor = { userId, contextIds: yield* drives.contextIds };
      const { projection } = yield* threads.threadSnapshot(actor, threadId);
      const state = yield* folders.state;
      const ownerId = contextOfProject(state.contexts, projection.thread.projectId);
      if (ownerId === null || !actor.contextIds.includes(ownerId))
        return yield* refuse("Thread not found.", "thread_not_found");
      return {
        // A folder's agent never acquires the person's unrelated owner trees.
        actor: { ...actor, contextIds: [ownerId] },
        projection,
        ownerId,
        home: homeOf(state.tree, { threadId, projectId: projection.thread.projectId, ownerId }),
      };
    }).pipe(Effect.mapError(collaborationFailure));

  const read = (sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
    Effect.gen(function* () {
      const caller = yield* source(sourceThreadId);
      const { projection } = yield* threads.threadSnapshot(caller.actor, targetThreadId);
      // Personal is always visible to a person in ThreadEngine, even with no context ids.
      // A work folder's agent must not acquire that implicit personal access.
      const state = yield* folders.state;
      if (contextOfProject(state.contexts, projection.thread.projectId) !== caller.ownerId)
        return yield* refuse("Thread not found.", "thread_not_found");
      return { caller, projection };
    }).pipe(Effect.mapError(collaborationFailure));

  const writable = (
    caller: OrchestrationV2ThreadProjection,
    target: OrchestrationV2ThreadProjection,
  ) =>
    !runtimeModeWithin(target.thread.runtimeMode, caller.thread.runtimeMode) ||
    (caller.thread.interactionMode === "plan" && target.thread.interactionMode !== "plan")
      ? refuse("That thread has more access than this thread.", "capability_denied")
      : Effect.void;

  return { source, read, writable, threads, drives, folders };
});

export type CollaborationAccess = Effect.Success<typeof makeAccess>;
