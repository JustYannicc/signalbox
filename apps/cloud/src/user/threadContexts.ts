import type { ProjectId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { canWrite, parseDriveId } from "../drive/driveAccess.ts";
import { driveOfProject } from "./contextProjects.ts";
import * as UserDrives from "./UserDrives.ts";

/** Where a new thread works: the drive it changes files in, and the context it acts as. */
export interface ThreadPlace {
  readonly contextId: SignalboxContextId;
  readonly driveId: string;
}

/** What `CloudThreadService` needs to know about contexts and drives: where a new thread works. */
export class ThreadContexts extends Context.Service<
  ThreadContexts,
  {
    /**
     * The drive a thread started in `projectId` works in and the context it
     * acts as, or null when the project is none of the acting user's or they
     * can't change files in its drive.
     */
    readonly placeOfProject: (projectId: ProjectId) => Effect.Effect<ThreadPlace | null>;
  }
>()("@signalbox/cloud/user/threadContexts") {}

/** In a user's object: their current contexts and drives. */
export const layer = Layer.effect(
  ThreadContexts,
  Effect.gen(function* () {
    const drives = yield* UserDrives.UserDrives;
    return ThreadContexts.of({
      placeOfProject: (projectId) =>
        Effect.gen(function* () {
          const userId = yield* drives.userId;
          const driveId = userId === null ? null : driveOfProject(projectId, userId);
          const parsed = driveId === null ? null : parseDriveId(driveId);
          if (driveId === null || parsed === null) return null;
          // `access` also says whether the user is still in the drive's context.
          return canWrite(yield* drives.access(driveId))
            ? { contextId: parsed.contextId, driveId }
            : null;
        }).pipe(
          // A storage or drive failure is a bug or an outage, not a rejected command.
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
  }),
);
