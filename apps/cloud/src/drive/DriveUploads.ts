import { MAX_PACK_BYTES } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DriveDirectory } from "./DriveDirectory.ts";
import { DrivePacks } from "./DrivePacks.ts";
import type { StoredCommit } from "./DriveStore.ts";
import { parseCommit } from "./git/gitObjects.ts";
import { PackError, verifyPack } from "./git/gitPack.ts";
import type { Bytes, Oid } from "./git/gitObjects.ts";

/**
 * A machine's pack upload, accepted or refused. The pack is checked object by
 * object (`verifyPack`), stored in R2, and only then indexed in the drive's
 * object, so a ref can never name an object the drive cannot read: an upload
 * cut off anywhere before the index commits leaves at most an unreferenced
 * file in R2.
 *
 * The one exception to "everything referenced is in the drive" is a remote's
 * head (`remoteHead`), which the caller has checked against the remote: its
 * parents stay on the remote, so a remote-backed drive holds its main line
 * one commit deep.
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
  /** A commit in the pack that is the remote's current head. Its parents may be absent. */
  readonly remoteHead?: Oid;
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
  const head = input.remoteHead === undefined ? undefined : pack.structure.get(input.remoteHead);
  if (input.remoteHead !== undefined && head?.type !== "commit") {
    return refused(`The pack does not hold commit ${input.remoteHead}.`);
  }
  // One lookup: the head's parents the drive lacks stay on the remote; anything else is refused.
  const parents = new Set(head === undefined ? [] : parseCommit(head.content).parents);
  const lacking = yield* drive.missing([...pack.external, ...parents]);
  const onRemote = new Set(lacking.filter((oid) => parents.has(oid)));
  const external = [...pack.external].filter((oid) => !onRemote.has(oid));
  const absent = lacking.filter((oid) => !onRemote.has(oid));
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
    ...(onRemote.size > 0 && input.remoteHead !== undefined ? { shallow: [input.remoteHead] } : {}),
  });
  if (registered._tag === "missing") {
    return refused(
      `The pack references ${registered.oids.length} objects the drive does not have.`,
    );
  }
  return { _tag: "ok", name: pack.name, objects: pack.objects.length } satisfies UploadResult;
});
