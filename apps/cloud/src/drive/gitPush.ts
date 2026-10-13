import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DriveDirectory, type DriveHandle } from "./DriveDirectory.ts";
import type { StoredCommit } from "./DriveStore.ts";
import { DriveReadError, makeDriveReader } from "./DriveReader.ts";
import {
  type Bytes,
  concatBytes as concat,
  deflate,
  type ObjectType,
  type Oid,
} from "./git/gitObjects.ts";

/**
 * Pushing one branch of a drive to its remote over git's smart HTTP, with no
 * machine (#135). The drive's commit index says which commits the remote
 * lacks: walking back from the branch stops at a commit the remote has (the
 * branch's base, or what was pushed before) or one the drive does not hold
 * (a remote-backed drive keeps the remote's history one commit deep). Their
 * objects are read from the drive's packs, diffing each commit's tree against
 * its first parent's, and written as one undeltified pack.
 *
 * Only the branch named is pushed, so nothing else in the drive, such as its
 * auto-saves, ever reaches the remote.
 */

export class PushRefused extends Schema.TaggedError<PushRefused>()("PushRefused", {
  message: Schema.String,
}) {}

const ZERO_OID: Oid = "0".repeat(40);

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Most object bytes one push reads: it is built in memory, in the user's object. */
const MAX_PUSH_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An object's header in a pack: its type and inflated size, 4 then 7 bits at a time. */
const entryHeader = (type: ObjectType, size: number) => {
  const bytes: Array<number> = [];
  let byte = (TYPE_CODES[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
};

const u32 = (value: number) =>
  Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);

/** A version 2 pack of whole objects. */
async function writePack(
  objects: ReadonlyArray<{ readonly type: ObjectType; readonly content: Bytes }>,
): Promise<Bytes> {
  const parts: Array<Uint8Array> = [encoder.encode("PACK"), u32(2), u32(objects.length)];
  for (const object of objects) {
    parts.push(entryHeader(object.type, object.content.length), await deflate(object.content));
  }
  const body = concat(parts);
  return concat([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);
}

const pktLine = (line: string) => {
  const bytes = encoder.encode(line);
  return concat([encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
};

/** The body of a `git-receive-pack` request that moves `ref` from `old` to `next`. */
export const receivePackRequest = (input: {
  readonly ref: string;
  readonly old: Oid | null;
  readonly next: Oid;
  readonly pack: Bytes;
}) =>
  concat([
    pktLine(
      `${input.old ?? ZERO_OID} ${input.next} ${input.ref}\0report-status object-format=sha1 agent=signalbox\n`,
    ),
    encoder.encode("0000"),
    input.pack,
  ]);

/** Reads `report-status`: whether the remote unpacked the pack and moved `ref`, or why not. */
export function receivePackResult(
  body: Uint8Array,
  ref: string,
): { readonly _tag: "ok" } | { readonly _tag: "refused"; readonly reason: string } {
  const lines: Array<string> = [];
  for (let at = 0; at + 4 <= body.length;) {
    const length = parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (!Number.isFinite(length)) break;
    if (length < 4) {
      at += 4;
      continue;
    }
    lines.push(decoder.decode(body.subarray(at + 4, at + length)).replace(/\n$/, ""));
    at += length;
  }
  const error = lines.find((line) => line.startsWith("ERR "));
  if (error !== undefined) return { _tag: "refused", reason: error.slice(4) };
  const unpack = lines.find((line) => line.startsWith("unpack "));
  if (unpack !== undefined && unpack !== "unpack ok") {
    return { _tag: "refused", reason: `The remote could not unpack the push: ${unpack.slice(7)}.` };
  }
  if (lines.includes(`ok ${ref}`)) return { _tag: "ok" };
  const rejected = lines.find((line) => line.startsWith(`ng ${ref} `));
  return {
    _tag: "refused",
    reason:
      rejected?.slice(`ng ${ref} `.length) ?? "The remote did not say whether it took the push.",
  };
}

/**
 * Commits on `head`'s history that are not behind any of `stop`, newest
 * first, walked through the drive's commit index. A parent the drive does
 * not hold ends the walk too: it is on the remote. `reached` says which of
 * `stop` the walk ran into.
 */
export const commitsSince = (drive: DriveHandle, head: Oid, stop: ReadonlySet<Oid>) =>
  Effect.gen(function* () {
    const commits: Array<StoredCommit> = [];
    const reached = new Set<Oid>();
    const seen = new Set<Oid>();
    let frontier: ReadonlyArray<Oid> = [head];
    while (frontier.length > 0) {
      const wanted = frontier.filter((oid) => {
        if (stop.has(oid)) reached.add(oid);
        if (stop.has(oid) || seen.has(oid)) return false;
        seen.add(oid);
        return true;
      });
      const found = yield* drive.commits(wanted);
      commits.push(...found);
      frontier = found.flatMap((commit) => commit.parents);
    }
    return { commits, reached };
  });

/**
 * The pack that brings a remote from `remoteHas` to `head`: every commit on
 * `head` it lacks and the objects they add. `old`, the remote branch's
 * current commit, must be on `head`'s history, so a push never drops commits
 * someone else added to the branch.
 */
export const packForPush = Effect.fn("gitPush.packForPush")(function* (input: {
  readonly driveId: string;
  readonly head: Oid;
  readonly old: Oid | null;
  readonly remoteHas: ReadonlyArray<Oid>;
}) {
  const reader = yield* makeDriveReader(input.driveId);
  const drive = (yield* DriveDirectory).forDrive(input.driveId);
  const stop = new Set([...input.remoteHas, ...(input.old === null ? [] : [input.old])]);
  const walked = yield* commitsSince(drive, input.head, stop);
  const commits = walked.commits.map((commit) => ({
    oid: commit.oid,
    tree: commit.tree,
    parent: commit.parents[0] ?? null,
  }));
  if (input.old !== null && input.old !== input.head && !walked.reached.has(input.old)) {
    return yield* new PushRefused({
      message: "The branch on the remote has commits this thread does not. Nothing was pushed.",
    });
  }

  const parentTrees = new Map<Oid, Oid>();
  const parents = commits.flatMap((commit) => (commit.parent === null ? [] : [commit.parent]));
  for (const commit of yield* drive.commits(parents)) parentTrees.set(commit.oid, commit.tree);

  // Trees and blobs each commit adds over its first parent.
  const objects = new Map<Oid, ObjectType>(commits.map((commit) => [commit.oid, "commit"]));
  type ReadFailure = Effect.Error<ReturnType<typeof reader.tree>>;
  const collect = (after: Oid, before: Oid | null): Effect.Effect<void, ReadFailure> =>
    Effect.gen(function* () {
      if (after === before || objects.has(after)) return;
      objects.set(after, "tree");
      const previous = new Map(
        (before === null ? [] : yield* reader.tree(before)).map((entry) => [entry.name, entry]),
      );
      for (const entry of yield* reader.tree(after)) {
        const old = previous.get(entry.name);
        if (old?.oid === entry.oid) continue;
        if (entry.kind === "directory") {
          yield* collect(entry.oid, old?.kind === "directory" ? old.oid : null);
        } else if (entry.kind !== "submodule") {
          objects.set(entry.oid, "blob");
        }
      }
    });
  for (const commit of commits) {
    yield* collect(
      commit.tree,
      commit.parent === null ? null : (parentTrees.get(commit.parent) ?? null),
    );
  }

  const located = yield* drive.locate([...objects.keys()]);
  const total = located.reduce((sum, location) => sum + location.size, 0);
  if (total > MAX_PUSH_BYTES) {
    return yield* new PushRefused({
      message: `This branch adds ${Math.ceil(total / 1024 / 1024)} MB, more than Signalbox pushes at once yet.`,
    });
  }
  const contents = yield* Effect.forEach(
    [...objects],
    ([oid, type]) =>
      Effect.flatMap(reader.object(oid), (object) =>
        object.type === type
          ? Effect.succeed({ type, content: object.content })
          : Effect.fail(
              new DriveReadError({ message: `${oid} is a ${object.type}, not a ${type}.` }),
            ),
      ),
    { concurrency: 8 },
  );
  const pack = yield* Effect.promise(() => writePack(contents));
  return { pack, commits: commits.length, objects: contents.length };
});
