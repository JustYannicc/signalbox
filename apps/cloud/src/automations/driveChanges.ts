import type { ExternalEvent } from "@signalbox/automations/WorkflowEngine";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { DriveRefEvent } from "../drive/DriveEvents.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import { makeDriveReader } from "../drive/DriveReader.ts";
import { MAIN_REF } from "../drive/DriveStore.ts";

/**
 * A drive's ref moves as automation events (#471): `drive.changed` when its
 * `main` moved, `drive.branch-saved` when a thread saved its branch. Which
 * files changed is read from the drive only when someone listens.
 */

/** Files an event lists; more sets `filesTruncated`. */
export const EVENT_FILES = 200;

/** A file an event lists, in a checkpoint's words (`DriveFileChange`), without line counts. */
export type DriveEventFile = {
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted";
};

/** Reads which files changed between two commits, when this object can read drives. */
export const makeChangedFiles = Effect.gen(function* () {
  const directory = yield* Effect.serviceOption(DriveDirectory);
  const packs = yield* Effect.serviceOption(DrivePacks);
  const drives =
    Option.isSome(directory) && Option.isSome(packs)
      ? { directory: directory.value, packs: packs.value }
      : null;
  return (driveId: string, before: string | null, after: string) =>
    drives === null
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          const reader = yield* makeDriveReader(driveId);
          const changed = yield* reader.changes(
            yield* reader.treeOf(before),
            yield* reader.treeOf(after),
          );
          return changed.map((file): DriveEventFile => ({
            path: file.path,
            kind: file.before === null ? "added" : file.after === null ? "deleted" : "modified",
          }));
        }).pipe(
          Effect.provideService(DriveDirectory, drives.directory),
          Effect.provideService(DrivePacks, drives.packs),
          // The event still goes out, saying it couldn't list them.
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't read a drive change's files", { driveId, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
});

export type ChangedFiles = Effect.Success<typeof makeChangedFiles>;

/** One move of `driveId` as the engine takes it, in the user's `projectId`. */
export const driveEvent = (
  driveId: string,
  projectId: string,
  move: DriveRefEvent,
  changedFiles: ChangedFiles,
): ExternalEvent => {
  const event = move.ref === MAIN_REF ? "drive.changed" : "drive.branch-saved";
  return {
    event,
    // The drive's sequence never repeats, so redeliveries share the id.
    id: `${event}:${driveId}:${move.sequence}`,
    at: DateTime.formatIso(DateTime.makeUnsafe(move.at)),
    projectId,
    threadId: move.threadId,
    fields: Effect.map(changedFiles(driveId, move.before, move.after), (files) => ({
      driveId,
      ref: move.ref,
      before: move.before,
      after: move.after,
      commits: move.commits,
      commitsTruncated: move.commitsTruncated,
      files: files?.slice(0, EVENT_FILES) ?? null,
      filesTruncated: files !== null && files.length > EVENT_FILES,
    })),
  };
};
