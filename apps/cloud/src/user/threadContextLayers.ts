import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { canWrite, parseDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { driveOfProject } from "./contextProjects.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserPools from "./UserPools.ts";
import * as UserModelSettings from "./UserModelSettings.ts";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import { forThread } from "../thread/turnPool.ts";

import { ThreadFolderTrashedError, ThreadContexts } from "./threadContexts.ts";

/** In a user's object: their current contexts and drives. */
export const layer = Layer.effect(
  ThreadContexts,
  Effect.gen(function* () {
    const drives = yield* UserDrives.UserDrives;
    const folders = yield* UserFolders.UserFolders;
    const directory = yield* Effect.serviceOption(DriveDirectory);
    const pools = yield* UserPools.UserPools;
    const modelSettings = yield* UserModelSettings.UserModelSettings;
    const catalog = yield* ModelCatalog.ModelCatalog;
    return ThreadContexts.of({
      initialModelSelection: (projectId, threadId = ThreadId.make("model-default")) =>
        Effect.gen(function* () {
          const userId = yield* drives.userId.pipe(Effect.orDie);
          if (userId === null) return null;
          const saved = yield* modelSettings.snapshot.pipe(Effect.orDie);
          const turn = yield* folders.turn({ threadId, projectId }).pipe(
            Effect.catchTags({
              ThreadHomeTrashedError: () => Effect.fail(new ThreadFolderTrashedError()),
              SqlError: Effect.die,
            }),
          );
          const pool = projectId === null ? turn.pools.top : forThread(turn.pools, projectId);
          const poolState = yield* pools.state({ userId }).pipe(Effect.orDie);
          return yield* catalog
            .initialSelection({
              pools: poolState,
              checkedAt: DateTime.formatIso(yield* DateTime.now),
              poolId: pool,
              personDefault: saved.defaultModelSelection,
            })
            .pipe(Effect.orDie);
        }),
      placeOfProject: (projectId) =>
        Effect.gen(function* () {
          const userId = yield* drives.userId.pipe(Effect.orDie);
          const driveId = userId === null ? null : driveOfProject(projectId, userId);
          const parsed = driveId === null ? null : parseDriveId(driveId);
          if (driveId === null || parsed === null) return null;
          // `access` also says whether the user is still in the drive's context.
          if (!canWrite(yield* drives.access(driveId).pipe(Effect.orDie))) return null;
          if (yield* folders.driveIsTrashed(driveId).pipe(Effect.orDie)) {
            return yield* Effect.fail(new ThreadFolderTrashedError());
          }
          // A My Drive is always its own home; any other drive says whether a remote is.
          const remote =
            parsed.kind !== "my" &&
            directory._tag === "Some" &&
            (yield* directory.value.forDrive(driveId).remote().pipe(Effect.orDie)) !== null;
          return { contextId: parsed.contextId, driveId, remote };
        }),
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
    initialModelSelection: () => Effect.die("Models are resolved in their user's object."),
    turn: () => Effect.die("Turns start in their user's object."),
  }),
);
