import * as Effect from "effect/Effect";

import { DrivePacks, type PackFile } from "./DrivePacks.ts";

/** Answers the drive API's routes share (`driveRoutes.ts`, `shortcutRoutes.ts`, `remoteRoutes.ts`). */

export const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

export const text = (body: string, status: number) => new Response(body, { status });

/** `decode(body)`, or null when the body doesn't decode. */
export const decodeBody = <A>(decode: (text: string) => A, body: string): A | null => {
  try {
    return decode(body);
  } catch {
    return null;
  }
};

const PACK_FILE = /^([0-9a-f]{40})\.(pack|idx)$/;

/** Serves `<name>.pack|.idx` of `driveId`'s packs; packs never change, so they cache for good. */
export const packResponse = (driveId: string, file: string) =>
  Effect.gen(function* () {
    const match = PACK_FILE.exec(file);
    if (match === null) return text("Unknown pack.", 404);
    const found = yield* (yield* DrivePacks).get(driveId, match[1]!, match[2] as PackFile);
    return found === null
      ? text("Unknown pack.", 404)
      : new Response(found.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(found.size),
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
  });
