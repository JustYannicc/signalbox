import type { ProjectId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { canWrite, parseDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import type { TurnPools } from "../thread/turnPool.ts";
import { driveOfProject } from "./contextProjects.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserSections from "./UserSections.ts";

/** Where a new thread works: the drive it changes files in, and the context it acts as. */
export interface ThreadPlace {
  readonly contextId: SignalboxContextId;
  readonly driveId: string;
  /** Whether the drive is backed by a remote repository, so each thread works on its own branch. */
  readonly remote: boolean;
}

/**
 * What `CloudThreadService` needs to know about the user's tree: where a new
 * thread works, and the pool each project's turns run on.
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
    /** Each current project's pool now, resolved from the tree (`poolChain.ts`). */
    readonly turnPools: Effect.Effect<TurnPools>;
  }
>()("@signalbox/cloud/user/threadContexts") {}

/** In a user's object: their current contexts and drives. */
export const layer = Layer.effect(
  ThreadContexts,
  Effect.gen(function* () {
    const drives = yield* UserDrives.UserDrives;
    const sections = yield* UserSections.UserSections;
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
      turnPools: sections.pools.pipe(
        Effect.map((pools): TurnPools => ({
          top: pools.top?.poolId ?? null,
          projects: Object.fromEntries(
            pools.projects.map((entry) => [entry.projectId, entry.pool?.poolId ?? null]),
          ),
        })),
        Effect.orDie,
      ),
    });
  }),
);

/** In the Worker, which only reads threads. Threads are created in their user's object. */
export const layerWorker = Layer.succeed(
  ThreadContexts,
  ThreadContexts.of({
    placeOfProject: () => Effect.die("Threads are created in their user's object."),
    turnPools: Effect.die("Turns start in their user's object."),
  }),
);
