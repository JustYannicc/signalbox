import { MAX_PACK_BYTES } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DriveDirectory } from "./DriveDirectory.ts";
import { DrivePacks } from "./DrivePacks.ts";
import type { StoredCommit } from "./DriveStore.ts";
import { parseCommit } from "./git/gitObjects.ts";
import { PackError, verifyPack } from "./git/gitPack.ts";
import type { Bytes } from "./git/gitObjects.ts";

/**
 * A machine's pack upload, accepted or refused. The pack is checked object by
 * object (`verifyPack`), stored in R2, and only then indexed in the drive's
 * object, so a ref can never name an object the drive cannot read: an upload
 * cut off anywhere before the index commits leaves at most an unreferenced
 * file in R2.
 */

export type UploadResult =
  | { readonly _tag: "ok"; readonly name: string; readonly objects: number }
  | { readonly _tag: "refused"; readonly reason: string };

class InvalidPack extends Schema.TaggedError<InvalidPack>()("InvalidPack", {
  reason: Schema.String,
}) {}

const refused = (reason: string): UploadResult => ({ _tag: "refused", reason });

export const uploadPack = Effect.fn("DriveUploads.uploadPack")(function* (input: {
  readonly driveId: string;
  readonly threadId: string;
  readonly idx: Bytes;
  readonly pack: Bytes;
}) {
  if (input.pack.length > MAX_PACK_BYTES) {
    return refused(`Packs over ${MAX_PACK_BYTES} bytes are not stored yet.`);
  }
  const verified = yield* Effect.tryPromise({
    try: () => verifyPack(input.pack, input.idx),
    catch: (cause) =>
      new InvalidPack({
        reason: cause instanceof PackError ? cause.message : "The pack could not be read.",
      }),
  }).pipe(Effect.result);
  if (verified._tag === "Failure") return refused(verified.failure.reason);
  const pack = verified.success;
  const drive = (yield* DriveDirectory).forDrive(input.driveId);
  const external = [...pack.external];
  const absent = yield* drive.missing(external);
  if (absent.length > 0) {
    return refused(`The pack references ${absent.length} objects the drive does not have.`);
  }
  yield* (yield* DrivePacks).put({
    driveId: input.driveId,
    name: pack.name,
    idx: input.idx,
    pack: input.pack,
  });
  const commits: Array<StoredCommit> = [];
  for (const [oid, object] of pack.structure) {
    if (object.type !== "commit") continue;
    const commit = parseCommit(object.content);
    commits.push({
      oid,
      tree: commit.tree,
      parents: commit.parents,
      authorName: commit.author.name,
      authorEmail: commit.author.email,
      time: commit.author.time,
      message: commit.message,
    });
  }
  const registered = yield* drive.registerPack({
    name: pack.name,
    size: input.pack.length,
    threadId: input.threadId,
    objects: pack.objects,
    commits,
    external,
  });
  if (registered._tag === "missing") {
    return refused(
      `The pack references ${registered.oids.length} objects the drive does not have.`,
    );
  }
  return { _tag: "ok", name: pack.name, objects: pack.objects.length } satisfies UploadResult;
});
