import type {
  SignalboxDriveAddShortcutInput,
  SignalboxDriveRemoveShortcutInput,
  SignalboxDriveShortcut,
} from "@t3tools/contracts/signalboxDrives";
import { SignalboxDriveError, SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { canWrite } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import { makeDriveReader, pathSegments } from "../drive/DriveReader.ts";
import { MAIN_REF, type Shortcut } from "../drive/DriveStore.ts";
import * as UserDrives from "./UserDrives.ts";

/**
 * Shortcuts in a drive's tree (#142), for the user whose object this is: a
 * folder that shows another drive they can open, with that drive's own access
 * and history. Adding one needs write access to the drive and access to the
 * target; the drive object checks the first again and keeps paths from
 * overlapping. A shortcut never takes a path the drive already has files at,
 * so nothing of the drive's own is hidden behind it, and a drive whose home
 * is a remote repository holds none: files may appear there at any path.
 *
 * Threads see shortcuts on their machines from their next turn on
 * (`RunnerShortcuts.ts` in the server), and removing one takes the folder
 * and its instructions away the same way.
 */

type Failure = SignalboxDriveError;

export class DriveShortcuts extends Context.Service<
  DriveShortcuts,
  {
    readonly list: (
      driveId: string,
    ) => Effect.Effect<ReadonlyArray<SignalboxDriveShortcut>, Failure>;
    readonly add: (
      input: SignalboxDriveAddShortcutInput,
    ) => Effect.Effect<SignalboxDriveShortcut, Failure>;
    readonly remove: (input: SignalboxDriveRemoveShortcutInput) => Effect.Effect<void, Failure>;
  }
>()("@signalbox/cloud/user/DriveShortcuts") {}

const refuse = (message: string) => Effect.fail(new SignalboxDriveError({ message }));

const unavailable = (cause: unknown) =>
  Effect.logError("drive shortcuts failed", { cause }).pipe(
    Effect.andThen(refuse("Drives are unavailable right now. Try again.")),
  );

/** Folder names git or the machine keep for themselves. */
const RESERVED = new Set([".git"]);

const make = Effect.gen(function* () {
  const drives = yield* UserDrives.UserDrives;
  const directory = yield* DriveDirectory;
  const packs = yield* DrivePacks;

  /**
   * The shortcuts as the user sees them: named from their drives list, and
   * asked of the target only when it isn't there (null when they can't open it).
   */
  const shown = (shortcuts: ReadonlyArray<Shortcut>) =>
    Effect.gen(function* () {
      const names = new Map<string, string>(
        (yield* drives.drives).map((drive) => [drive.id, drive.name]),
      );
      return yield* Effect.forEach(
        shortcuts,
        (shortcut) =>
          Effect.gen(function* () {
            const listed = names.get(shortcut.target);
            const name =
              listed ??
              ((yield* drives.access(shortcut.target)) === null
                ? null
                : ((yield* directory.forDrive(shortcut.target).driveName()) ?? "Drive"));
            return {
              path: TrimmedNonEmptyString.make(shortcut.path),
              target: SignalboxDriveId.make(shortcut.target),
              name,
            } satisfies SignalboxDriveShortcut;
          }),
        { concurrency: 4 },
      );
    });

  const me = Effect.flatMap(drives.userId, (userId) =>
    userId === null ? refuse("Sign in again to change shortcuts.") : Effect.succeed(userId),
  );

  /** Whether `segments` is free on the drive's `main`: nothing there, and only folders above it. */
  const freeAt = (driveId: string, segments: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const reader = yield* makeDriveReader(driveId).pipe(
        Effect.provideService(DriveDirectory, directory),
        Effect.provideService(DrivePacks, packs),
      );
      const main = yield* reader.drive.ref(MAIN_REF);
      if (main === null) return true;
      const root = yield* reader.treeOf(main);
      for (let depth = 1; depth <= segments.length; depth++) {
        const entry = yield* reader.entryAt(root, segments.slice(0, depth));
        if (entry === null) return true;
        if (depth === segments.length || entry.kind !== "directory") return false;
      }
      return true;
    });

  const role = (driveId: string) =>
    Effect.flatMap(drives.access(driveId), (found) =>
      found === null ? refuse("You don't have access to that drive.") : Effect.succeed(found),
    );

  const list: DriveShortcuts["Service"]["list"] = (driveId) =>
    Effect.gen(function* () {
      yield* role(driveId);
      return yield* shown(yield* directory.forDrive(driveId).shortcuts());
    }).pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));

  const add: DriveShortcuts["Service"]["add"] = (input) =>
    Effect.gen(function* () {
      if (!canWrite(yield* role(input.driveId)))
        return yield* refuse("You can't change this drive.");
      if (input.target === input.driveId)
        return yield* refuse("A drive can't hold a shortcut to itself.");
      // Its home is the remote: files there may appear at any path, and a shortcut would hide them.
      if ((yield* directory.forDrive(input.driveId).remote()) !== null) {
        return yield* refuse("This drive lives on GitHub, so it can't hold shortcuts.");
      }
      if ((yield* drives.access(input.target)) === null) {
        return yield* refuse("You don't have access to the drive you picked.");
      }
      const segments = pathSegments(input.path);
      if (segments === null || segments.length === 0) return yield* refuse("Choose a folder name.");
      if (segments.some((segment) => RESERVED.has(segment))) {
        return yield* refuse(`${input.path} can't be a shortcut.`);
      }
      const path = segments.join("/");
      // A shortcut never hides the drive's own files, nor sits under a file or link.
      if (!(yield* freeAt(input.driveId, segments))) {
        return yield* refuse(`${path} already exists in this drive. Pick another name.`);
      }
      const shortcut = { path, target: input.target };
      const added = yield* directory.forDrive(input.driveId).addShortcut(yield* me, shortcut);
      if (added._tag === "refused") return yield* refuse(added.reason);
      return (yield* shown([shortcut]))[0]!;
    }).pipe(
      Effect.catchTags({
        SqlError: unavailable,
        DriveObjectError: unavailable,
        DrivePackError: unavailable,
        DriveReadError: unavailable,
      }),
    );

  const remove: DriveShortcuts["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      if (!canWrite(yield* role(input.driveId)))
        return yield* refuse("You can't change this drive.");
      const segments = pathSegments(input.path);
      if (segments === null || segments.length === 0) return yield* refuse("Choose a shortcut.");
      const removed = yield* directory
        .forDrive(input.driveId)
        .removeShortcut(yield* me, segments.join("/"));
      if (removed._tag === "refused") return yield* refuse(removed.reason);
    }).pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));

  return DriveShortcuts.of({ list, add, remove });
});

export const layer = Layer.effect(DriveShortcuts, make);
