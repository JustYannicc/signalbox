import { DRIVE_PATHS, driveJson } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";

import * as DriveShortcuts from "./DriveShortcuts.ts";
import { decodeBody, json, packResponse, text } from "./routeResponses.ts";

/**
 * What a thread's machine reads of its drive's shortcuts (#142): each target's
 * `main` and packs, so it can mount the target at the shortcut's path. A
 * target is only readable while the thread's user can open it, asked of their
 * own object on every call, so losing access takes the mount down at the next
 * turn and stops its packs at once. Nothing here writes; a thread only ever
 * writes its own drive.
 */

const PACK_PATH = /^([^/]+)\/packs\/([^/]+)$/;

/** `DRIVE_PATHS.shortcuts` and the packs under it, for an authorized machine. */
export const shortcutRoute = (reader: DriveShortcuts.ShortcutReader, request: Request) =>
  Effect.gen(function* () {
    const { pathname } = new URL(request.url);
    if (pathname === DRIVE_PATHS.shortcuts) {
      if (request.method !== "POST") return text("Method not allowed.", 405);
      const body = yield* Effect.promise(() => request.text());
      const decoded = decodeBody(driveJson.shortcutsRequest.decode, body);
      if (decoded === null) return text("Unreadable request.", 400);
      const service = yield* DriveShortcuts.DriveShortcuts;
      const shortcuts = yield* service.list(reader, decoded.have);
      return json(driveJson.shortcuts.encode({ shortcuts }));
    }
    const match = PACK_PATH.exec(pathname.slice(DRIVE_PATHS.shortcuts.length + 1));
    const target = match === null ? null : decodeBody(decodeURIComponent, match[1]!);
    if (request.method !== "GET" || target === null) return text("Unknown path.", 404);
    const service = yield* DriveShortcuts.DriveShortcuts;
    if (!(yield* service.reads(reader, target))) {
      return text("This drive has no shortcut to that drive you can open.", 403);
    }
    return yield* packResponse(target, match![2]!);
  });
