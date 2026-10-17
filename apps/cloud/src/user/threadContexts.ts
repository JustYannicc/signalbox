import { type ModelSelection, type ProjectId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { canWrite, parseDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import type { TurnInstructions, TurnPools, TurnSecrets } from "../thread/turnPool.ts";
import { driveOfProject } from "./contextProjects.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserPools from "./UserPools.ts";
import * as UserModelSettings from "./UserModelSettings.ts";
import * as ModelManifest from "../thread/ModelManifest.ts";
import { poolProviders } from "../pool/poolViews.ts";
import { poolIdOfInstance } from "../thread/providerCatalog.ts";
import { forThread, onPool } from "../thread/turnPool.ts";

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
    readonly placeOfProject: (projectId: ProjectId) => Effect.Effect<ThreadPlace | null>;
    readonly initialModelSelection: (
      projectId: ProjectId | null,
      threadId?: ThreadId,
    ) => Effect.Effect<ModelSelection | null>;
    /**
     * The thread's turn now, resolved from its home's chain (`folderTree.ts`).
     * `projectId`: the thread's, when the caller knows it (a create does).
     */
    readonly turn: (threadId: ThreadId, projectId: ProjectId | null) => Effect.Effect<ThreadTurn>;
  }
>()("@signalbox/cloud/user/threadContexts") {}

/** In a user's object: their current contexts and drives. */
export const layer = Layer.effect(
  ThreadContexts,
  Effect.gen(function* () {
    const drives = yield* UserDrives.UserDrives;
    const folders = yield* UserFolders.UserFolders;
    const directory = yield* Effect.serviceOption(DriveDirectory);
    const pools = yield* UserPools.UserPools;
    const modelSettings = yield* UserModelSettings.UserModelSettings;
    const manifest = yield* ModelManifest.ModelManifest;
    return ThreadContexts.of({
      initialModelSelection: (projectId, threadId = ThreadId.make("model-default")) =>
        Effect.gen(function* () {
          const userId = yield* drives.userId;
          if (userId === null) return null;
          const saved = yield* modelSettings.snapshot;
          const turn = yield* folders.turn({ threadId, projectId });
          const pool = projectId === null ? turn.pools.top : forThread(turn.pools, projectId);
          const providers = poolProviders(
            yield* pools.state({ userId }),
            DateTime.formatIso(yield* DateTime.now),
            yield* manifest.current,
          ).filter(
            (provider) =>
              provider.enabled &&
              provider.installed &&
              provider.status !== "error" &&
              provider.availability !== "unavailable" &&
              provider.auth.status !== "unauthenticated",
          );
          // Cloud folder model storage belongs to #811. Keep the person's
          // existing preference, on the folder's pool, until that setting exists.
          const destinationProviders =
            pool === null
              ? providers
              : providers.filter((provider) => poolIdOfInstance(provider.instanceId) === pool);
          const preference =
            saved.defaultModelSelection && pool
              ? onPool(saved.defaultModelSelection, pool)
              : saved.defaultModelSelection;
          const supportedPreference =
            preference &&
            (pool === null ||
              preference.instanceId === saved.defaultModelSelection?.instanceId ||
              destinationProviders.some(
                (provider) =>
                  provider.instanceId === preference.instanceId &&
                  provider.models.some(
                    (model) =>
                      !model.isLegacy &&
                      (model.slug === preference.model ||
                        model.aliases?.includes(preference.model)),
                  ),
              ))
              ? preference
              : null;
          return resolveInitialModelSelection({
            personDefault: supportedPreference,
            providers: destinationProviders,
          });
        }).pipe(Effect.orDie),
      placeOfProject: (projectId) =>
        Effect.gen(function* () {
          const userId = yield* drives.userId;
          const driveId = userId === null ? null : driveOfProject(projectId, userId);
          const parsed = driveId === null ? null : parseDriveId(driveId);
          if (driveId === null || parsed === null) return null;
          // `access` also says whether the user is still in the drive's context.
          if (!canWrite(yield* drives.access(driveId))) return null;
          // A My Drive is always its own home; any other drive says whether a remote is.
          const remote =
            parsed.kind !== "my" &&
            directory._tag === "Some" &&
            (yield* directory.value.forDrive(driveId).remote()) !== null;
          return { contextId: parsed.contextId, driveId, remote };
        }).pipe(
          // A storage or drive failure is a bug or an outage, not a rejected command.
          Effect.orDie,
        ),
      turn: (threadId, projectId) => Effect.orDie(folders.turn({ threadId, projectId })),
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
