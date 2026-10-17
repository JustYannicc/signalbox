import type { DriveShortcut } from "@signalbox/runner-protocol/DriveProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DriveDirectory, type DriveObjectError } from "./DriveDirectory.ts";
import { UserDirectory, type UserObjectError } from "../user/UserDirectory.ts";

/** The thread's own drive and user, whose current access gates each target. */
export interface ShortcutReader {
  readonly userId: string;
  readonly threadId?: string;
  readonly driveId: string;
}

export class DriveShortcuts extends Context.Service<
  DriveShortcuts,
  {
    readonly list: (
      reader: ShortcutReader,
      have: Readonly<Record<string, number>>,
    ) => Effect.Effect<ReadonlyArray<DriveShortcut>, DriveObjectError | UserObjectError>;
    readonly reads: (
      reader: ShortcutReader,
      target: string,
    ) => Effect.Effect<boolean, DriveObjectError | UserObjectError>;
  }
>()("@signalbox/cloud/drive/DriveShortcuts") {}

const make = Effect.gen(function* () {
  const directory = yield* DriveDirectory;
  const users = yield* UserDirectory;

  const shortcutsOf = (reader: ShortcutReader) =>
    Effect.gen(function* () {
      const drive = directory.forDrive(reader.driveId);
      const pins =
        reader.threadId === undefined
          ? null
          : (yield* drive.refs(reader.threadId, Number.MAX_SAFE_INTEGER)).pinnedViews;
      return pins === undefined || pins === null
        ? (yield* drive.shortcuts()).map((shortcut) => ({
            ...shortcut,
            pinned: false,
            commit: null,
          }))
        : pins.shortcuts.map((shortcut) => ({ ...shortcut, pinned: true }));
    });

  const list: DriveShortcuts["Service"]["list"] = (reader, have) =>
    Effect.gen(function* () {
      const user = users.forUser(reader.userId);
      const shortcuts = yield* shortcutsOf(reader);
      return yield* Effect.forEach(
        shortcuts,
        (shortcut) =>
          Effect.gen(function* () {
            const identity = {
              path: shortcut.path,
              target: shortcut.target,
              ...(shortcut.pinned ? { pinned: true } : {}),
            };
            const unreadable: DriveShortcut = {
              ...identity,
              readable: false,
              main: null,
              packs: [],
              shallow: [],
              remote: null,
            };
            if ((yield* user.driveAccess(shortcut.target)) === null) return unreadable;
            const refs = yield* directory
              .forDrive(shortcut.target)
              .refs(null, have[shortcut.target] ?? 0);
            return {
              ...identity,
              readable: true,
              main: shortcut.pinned ? shortcut.commit : refs.main,
              packs: refs.packs,
              shallow: refs.shallow,
              remote: refs.remote,
            } satisfies DriveShortcut;
          }),
        { concurrency: 4 },
      );
    });

  const reads: DriveShortcuts["Service"]["reads"] = (reader, target) =>
    Effect.gen(function* () {
      const [shortcuts, role] = yield* Effect.all(
        [shortcutsOf(reader), users.forUser(reader.userId).driveAccess(target)],
        { concurrency: 2 },
      );
      return role !== null && shortcuts.some((shortcut) => shortcut.target === target);
    });

  return DriveShortcuts.of({ list, reads });
});

export const layer = Layer.effect(DriveShortcuts, make);
