import { MAX_PACK_BYTES } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DriveDirectory } from "./DriveDirectory.ts";
import { DrivePacks } from "./DrivePacks.ts";
import type { StoredCommit } from "./DriveStore.ts";
import { parseCommit, parseTree } from "./git/gitObjects.ts";
import { PackError, type VerifiedPack, verifyPack } from "./git/gitPack.ts";
import type { Bytes, Oid } from "./git/gitObjects.ts";

/**
 * A machine's pack upload, accepted or refused. The pack is checked object by
 * object (`verifyPack`), stored in R2, and only then indexed in the drive's
 * object, so a ref can never name an object the drive cannot read: an upload
 * cut off anywhere before the index commits leaves at most an unreferenced
 * file in R2.
 *
 * The exception to "everything referenced is in the drive" is a remote's
 * head (`remoteHead`), which the caller has checked against the remote: its
 * parents stay on the remote, so a remote-backed drive holds its main line
 * one commit deep. And its files stay there too (#406): the pack holds the
 * commit and its folders, and the files those folders name that the drive
 * lacks become promised, kept by the remote. Only a checked head promises,
 * and only files its own folders name, so what the drive relies on the remote
 * for is exactly what the remote has.
 */

export type UploadResult =
  | { readonly _tag: "ok"; readonly name: string; readonly objects: number }
  | { readonly _tag: "refused"; readonly reason: string };

class InvalidPack extends Schema.TaggedError<InvalidPack>()("InvalidPack", {
  reason: Schema.String,
}) {}

export const refused = (reason: string): UploadResult => ({ _tag: "refused", reason });

/**
 * A checked pack, accepted or refused: the closure check, then `store` puts
 * its bytes where the drive keeps packs, and only then the drive indexes it.
 * Both ways a pack arrives end here: in a request's body (`uploadPack`), or
 * uploaded straight to storage and read back (`directUploads.ts`).
 */
export const acceptPack = Effect.fn("DriveUploads.acceptPack")(function* <
  E,
  R1,
  R2 = never,
>(input: {
  readonly driveId: string;
  readonly threadId: string;
  readonly pack: VerifiedPack;
  /** The pack's length in bytes. */
  readonly size: number;
  readonly store: Effect.Effect<void, E, R1>;
  /** A commit in the pack that is the remote's current head. Its parents and files may be absent. */
  readonly remoteHead?: Oid;
  /** The sizes of the remote head's files as the remote lists them, asked only when it promises any. */
  readonly promisedSizes?: Effect.Effect<ReadonlyMap<Oid, number>, never, R2>;
}) {
  const { pack } = input;
  const drive = (yield* DriveDirectory).forDrive(input.driveId);
  const head = input.remoteHead === undefined ? undefined : pack.structure.get(input.remoteHead);
  if (input.remoteHead !== undefined && head?.type !== "commit") {
    return refused(`The pack does not hold commit ${input.remoteHead}.`);
  }
  // One lookup: the head's parents the drive lacks stay on the remote; anything else is refused.
  const parents = new Set(head === undefined ? [] : parseCommit(head.content).parents);
  const lacking = yield* drive.missing([...pack.external, ...parents]);
  const onRemote = new Set(lacking.filter((oid) => parents.has(oid)));
  // A checked head's folders name files the remote keeps: those it lacks, the drive is promised.
  // Only the folders it reaches: another tree in the pack could name anything as a file.
  const files = new Set<Oid>();
  const folders = head === undefined ? [] : [parseCommit(head.content).tree];
  for (const seen = new Set<Oid>(); folders.length > 0;) {
    const oid = folders.pop()!;
    const folder = pack.structure.get(oid);
    if (seen.has(oid) || folder?.type !== "tree") continue;
    seen.add(oid);
    for (const entry of parseTree(folder.content)) {
      if (entry.kind === "directory") folders.push(entry.oid);
      else if (entry.kind !== "submodule") files.add(entry.oid);
    }
  }
  const promised = lacking.filter((oid) => files.has(oid));
  const kept = new Set([...onRemote, ...promised]);
  // What the remote keeps isn't checked again as the pack registers: it registers with it.
  const external = [...pack.external].filter((oid) => !kept.has(oid));
  const absent = lacking.filter((oid) => !kept.has(oid));
  if (absent.length > 0) {
    return refused(`The pack references ${absent.length} objects the drive does not have.`);
  }
  yield* input.store;
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
    size: input.size,
    threadId: input.threadId,
    objects: pack.objects,
    commits,
    external,
    ...(onRemote.size > 0 && input.remoteHead !== undefined ? { shallow: [input.remoteHead] } : {}),
    ...(promised.length > 0
      ? {
          promised: yield* Effect.map(
            input.promisedSizes ?? Effect.succeed(new Map<Oid, number>()),
            (sizes) => promised.map((oid) => ({ oid, size: sizes.get(oid) ?? null })),
          ),
        }
      : {}),
  });
  if (registered._tag === "missing") {
    return refused(
      `The pack references ${registered.oids.length} objects the drive does not have.`,
    );
  }
  return { _tag: "ok", name: pack.name, objects: pack.objects.length } satisfies UploadResult;
});

/** A pack uploaded in a request's body, checked in memory. */
export const uploadPack = Effect.fn("DriveUploads.uploadPack")(function* <R = never>(input: {
  readonly driveId: string;
  readonly threadId: string;
  readonly idx: Bytes;
  readonly pack: Bytes;
  readonly remoteHead?: Oid;
  readonly promisedSizes?: Effect.Effect<ReadonlyMap<Oid, number>, never, R>;
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
  const packs = yield* DrivePacks;
  return yield* acceptPack({
    driveId: input.driveId,
    threadId: input.threadId,
    pack: verified.success,
    size: input.pack.length,
    store: packs.put({
      driveId: input.driveId,
      name: verified.success.name,
      idx: input.idx,
      pack: input.pack,
    }),
    ...(input.remoteHead === undefined ? {} : { remoteHead: input.remoteHead }),
    ...(input.promisedSizes === undefined ? {} : { promisedSizes: input.promisedSizes }),
  });
});
