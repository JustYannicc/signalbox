import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";

import { canWrite, myDriveId } from "../drive/driveAccess.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import { ThreadDrives, ThreadSecrets } from "./runner/ThreadRunner.ts";

export const layerDrives = (options: { readonly enabled: boolean }) =>
  Layer.effect(
    ThreadDrives,
    Effect.map(UserDirectory, (users) => ({
      enabled: options.enabled,
      writes: (userId: string, driveId: string) =>
        // Personal My Drive never goes away, so its owner needs no role lookup.
        driveId === myDriveId(PERSONAL_CONTEXT_ID, userId)
          ? Effect.succeed(true)
          : Effect.map(users.forUser(userId).driveAccess(driveId), canWrite),
      commitAuthor: (userId: string) => users.forUser(userId).githubCommitAuthor(),
    })),
  );

export const layerSecrets = Layer.effect(
  ThreadSecrets,
  Effect.map(UserDirectory, (users) => ({
    token: (userId: string) => users.forUser(userId).onePasswordToken(),
  })),
);
