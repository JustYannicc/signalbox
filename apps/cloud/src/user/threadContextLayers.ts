import { ThreadId } from "@t3tools/contracts";
import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";
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
import * as ModelManifest from "../thread/ModelManifest.ts";
import { poolProviders } from "../pool/poolViews.ts";
import { poolIdOfInstance } from "../thread/providerCatalog.ts";
import { forThread, onPool } from "../thread/turnPool.ts";

import { ThreadContexts } from "./threadContexts.ts";

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
      placeOfProject: (projectId, options) =>
        Effect.gen(function* () {
          const userId = yield* drives.userId;
          const driveId = userId === null ? null : driveOfProject(projectId, userId);
          const parsed = driveId === null ? null : parseDriveId(driveId);
          if (driveId === null || parsed === null) return null;
          if (options?.remoteOnly === true) {
            // Only a drive with a remote needs adoption. Check it before the separate role RPC.
            if (
              parsed.kind === "my" ||
              directory._tag === "None" ||
              (yield* directory.value.forDrive(driveId).remote()) === null
            )
              return null;
            if (!canWrite(yield* drives.access(driveId))) return null;
            return { contextId: parsed.contextId, driveId, remote: true };
          }
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
    // Worker reads cannot resolve an acting user's writable home. Adoption happens in their object.
    placeOfProject: () => Effect.succeed(null),
    initialModelSelection: () => Effect.die("Models are resolved in their user's object."),
    turn: () => Effect.die("Turns start in their user's object."),
  }),
);
