import { type OrchestrationV2ThreadProjection, type ThreadId } from "@t3tools/contracts";
import { runtimeModeWithin } from "@signalbox/automations/access";
import * as Effect from "effect/Effect";

import { CloudThreadService } from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { contextOfProject } from "../user/contextProjects.ts";
import { homeOf } from "../user/folderTree.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { UserFolders } from "../user/UserFolders.ts";
import { CollaborationError } from "./errors.ts";

export const refuse = (message: string, code: CollaborationError["code"] = "invalid_request") =>
  Effect.fail(new CollaborationError({ code, message }));

export const makeAccess = Effect.gen(function* () {
  const threads = yield* CloudThreadService;
  const drives = yield* UserDrives;
  const folders = yield* UserFolders;

  const source = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const userId = yield* drives.userId.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(CollaborationError.unavailable("read_source_user", cause)),
        }),
      );
      if (userId === null) return yield* refuse("Thread not found.", "thread_not_found");
      const actor: Actor = {
        userId,
        contextIds: yield* drives.contextIds.pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(CollaborationError.unavailable("read_source_contexts", cause)),
          }),
        ),
      };
      const { projection } = yield* threads.threadSnapshot(actor, threadId).pipe(
        Effect.catchTags({
          ThreadNotFoundError: (cause) =>
            Effect.fail(
              new CollaborationError({
                code: "thread_not_found",
                message: "Thread not found.",
                cause,
              }),
            ),
          ThreadObjectError: (cause) =>
            Effect.fail(CollaborationError.unavailable("read_source_thread", cause)),
        }),
      );
      const state = yield* folders.state.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(CollaborationError.unavailable("read_source_home", cause)),
        }),
      );
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
    });

  const read = (sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
    Effect.gen(function* () {
      const caller = yield* source(sourceThreadId);
      const { projection } = yield* threads.threadSnapshot(caller.actor, targetThreadId).pipe(
        Effect.catchTags({
          ThreadNotFoundError: (cause) =>
            Effect.fail(
              new CollaborationError({
                code: "thread_not_found",
                message: "Thread not found.",
                cause,
              }),
            ),
          ThreadObjectError: (cause) =>
            Effect.fail(CollaborationError.unavailable("read_target_thread", cause)),
        }),
      );
      // Personal is always visible to a person in ThreadEngine, even with no context ids.
      // A work folder's agent must not acquire that implicit personal access.
      const state = yield* folders.state.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(CollaborationError.unavailable("read_target_home", cause)),
        }),
      );
      if (contextOfProject(state.contexts, projection.thread.projectId) !== caller.ownerId)
        return yield* refuse("Thread not found.", "thread_not_found");
      return { caller, projection };
    });

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
