import {
  DRIVE_PATHS,
  type DriveShortcut,
  driveJson,
} from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";

import { UserDirectory } from "../user/UserDirectory.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import { decodeBody, json, packResponse, text } from "./routeResponses.ts";

/**
 * What a thread's machine reads of its drive's shortcuts (#142): each target's
 * `main` and packs, so it can mount the target at the shortcut's path. A
 * target is only readable while the thread's user can open it, asked of their
 * own object on every call, so losing access takes the mount down at the next
 * turn and stops its packs at once. Nothing here writes; a thread only ever
 * writes its own drive.
 */

export interface ShortcutReader {
  readonly userId: string;
  /** The thread's own drive, whose shortcuts these are. */
  readonly driveId: string;
}

/** The thread's shortcuts, each with its target as the user may read it now. */
export const listShortcuts = (reader: ShortcutReader, have: Readonly<Record<string, number>>) =>
  Effect.gen(function* () {
    const directory = yield* DriveDirectory;
    const user = (yield* UserDirectory).forUser(reader.userId);
    const shortcuts = yield* directory.forDrive(reader.driveId).shortcuts();
    return yield* Effect.forEach(
      shortcuts,
      (shortcut) =>
        Effect.gen(function* () {
          const unreadable: DriveShortcut = {
            ...shortcut,
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
            ...shortcut,
            readable: true,
            main: refs.main,
            packs: refs.packs,
            shallow: refs.shallow,
            remote: refs.remote,
          } satisfies DriveShortcut;
        }),
      { concurrency: 4 },
    );
  });

/** Whether `target` is one of the drive's shortcuts and the user can open it right now. */
export const readsShortcut = (reader: ShortcutReader, target: string) =>
  Effect.gen(function* () {
    const [shortcuts, role] = yield* Effect.all(
      [
        (yield* DriveDirectory).forDrive(reader.driveId).shortcuts(),
        (yield* UserDirectory).forUser(reader.userId).driveAccess(target),
      ],
      { concurrency: 2 },
    );
    return role !== null && shortcuts.some((shortcut) => shortcut.target === target);
  });

const PACK_PATH = /^([^/]+)\/packs\/([^/]+)$/;

/** `DRIVE_PATHS.shortcuts` and the packs under it, for an authorized machine. */
export const shortcutRoute = (reader: ShortcutReader, request: Request) =>
  Effect.gen(function* () {
    const { pathname } = new URL(request.url);
    if (pathname === DRIVE_PATHS.shortcuts) {
      if (request.method !== "POST") return text("Method not allowed.", 405);
      const body = yield* Effect.promise(() => request.text());
      const decoded = decodeBody(driveJson.shortcutsRequest.decode, body);
      if (decoded === null) return text("Unreadable request.", 400);
      const shortcuts = yield* listShortcuts(reader, decoded.have);
      return json(driveJson.shortcuts.encode({ shortcuts }));
    }
    const match = PACK_PATH.exec(pathname.slice(DRIVE_PATHS.shortcuts.length + 1));
    const target = match === null ? null : decodeBody(decodeURIComponent, match[1]!);
    if (request.method !== "GET" || target === null) return text("Unknown path.", 404);
    if (!(yield* readsShortcut(reader, target))) {
      return text("This drive has no shortcut to that drive you can open.", 403);
    }
    return yield* packResponse(target, match![2]!);
  });
