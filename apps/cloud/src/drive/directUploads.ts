import {
  type DirectUploadOffer,
  MAX_DIRECT_PACK_BYTES,
} from "@signalbox/runner-protocol/DriveProtocol";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { MAX_DIRECT_INDEX_BYTES, type DirectStorage } from "./directStorage.ts";
export { s3Storage, type DirectStorage, type DirectUploadsEnv } from "./directStorage.ts";

import { attempt, drivePackKey, drivePackPrefix, type PackBucket } from "./DrivePacks.ts";
import { acceptPack, refused } from "./DriveUploads.ts";
import { PackError } from "./git/gitPack.ts";
import { verifyPackStream } from "./git/gitPackStream.ts";
import type { Oid } from "./git/gitObjects.ts";

/**
 * Packs uploaded straight to storage (#406), so no pack meets a request's
 * body limit or an isolate's memory on its way in:
 *
 * 1. `offer` hands the machine two presigned `PUT` URLs, good for
 *    `DIRECT_UPLOAD_URL_SECONDS`, for `incoming/<preview prefix><drive>/<upload>.{pack,idx}`.
 * 2. The machine puts the bytes there itself.
 * 3. `commit` reads the upload back as a stream, checks it
 *    (`verifyPackStream`) and the drive's closure (`acceptPack`), copies it
 *    to where the drive keeps packs (in storage, not through the Worker),
 *    then deletes the upload. A storage lifecycle rule removes uploads
 *    nobody committed.
 *
 * It needs S3 credentials for the packs bucket, which presign and copy; a
 * cloud without them offers `inline`, and machines upload in a request's body
 * as before. The upload's names are per drive, so a thread only ever commits
 * its own drive's uploads.
 */

/** Under one top-level `incoming/` in every bucket, so one lifecycle rule clears what nobody committed. */
export const incomingKey = (driveId: string, uploadId: string, file: "pack" | "idx", prefix = "") =>
  `incoming/${prefix}${driveId}/${uploadId}.${file}`;

export const makeDirectUploads = (input: {
  readonly bucket: PackBucket;
  readonly storage: DirectStorage;
  readonly prefix?: string | undefined;
}) => {
  const { bucket, storage } = input;
  const prefix = drivePackPrefix(input.prefix);
  const presignPut = (key: string, size: number) =>
    attempt("presign", () => storage.presignPut(key, size));
  const copy = (from: string, to: string) => attempt("copy", () => storage.copy(from, to));

  const offer = Effect.fn("DirectUploads.offer")(function* (
    driveId: string,
    request: { readonly packSize: number; readonly idxSize: number },
  ) {
    if (request.packSize > MAX_DIRECT_PACK_BYTES || request.idxSize > MAX_DIRECT_INDEX_BYTES) {
      return { _tag: "too_large" } as const;
    }
    const uploadId = yield* Effect.orDie((yield* Crypto.Crypto).randomUUIDv4());
    const [pack, idx] = yield* Effect.all(
      [
        presignPut(incomingKey(driveId, uploadId, "pack", prefix), request.packSize),
        presignPut(incomingKey(driveId, uploadId, "idx", prefix), request.idxSize),
      ],
      { concurrency: 2 },
    );
    return { _tag: "direct", uploadId, pack, idx } as const satisfies DirectUploadOffer;
  });

  /** Reads, checks and stores an upload; drops it once it has an answer, leaving failures for a retry. */
  const commit = Effect.fn("DirectUploads.commit")(function* <R = never>(input: {
    readonly driveId: string;
    readonly threadId: string;
    readonly uploadId: string;
    readonly remoteHead?: Oid;
    readonly remoteCommits?: ReadonlyArray<Oid>;
    readonly promisedSizes?: Effect.Effect<ReadonlyMap<Oid, number>, never, R>;
    readonly private?: boolean;
  }) {
    if (!/^[0-9a-f-]{36}$/.test(input.uploadId)) return refused("Unknown upload.");
    const packKey = incomingKey(input.driveId, input.uploadId, "pack", prefix);
    const idxKey = incomingKey(input.driveId, input.uploadId, "idx", prefix);
    const [pack, idx] = yield* Effect.all(
      [attempt("get", () => bucket.get(packKey)), attempt("get", () => bucket.get(idxKey))],
      { concurrency: 2 },
    );
    const release = attempt("cancel", () =>
      Promise.all([pack?.body.cancel(), idx?.body.cancel()]),
    ).pipe(Effect.ignore);
    if (pack === null || idx === null) {
      yield* release;
      return refused("Nothing was uploaded there.");
    }
    const answer = yield* Effect.gen(function* () {
      if (pack.size > MAX_DIRECT_PACK_BYTES) {
        yield* release;
        return refused(`A pack of ${pack.size} bytes is more than a drive takes at once.`);
      }
      if (idx.size > MAX_DIRECT_INDEX_BYTES) {
        yield* release;
        return refused(`A pack index of ${idx.size} bytes is more than a drive reads at once.`);
      }
      const idxBytes = new Uint8Array(yield* attempt("get", () => idx.arrayBuffer()));
      const verified = yield* Effect.tryPromise({
        try: () => verifyPackStream({ stream: pack.body, size: pack.size, idx: idxBytes }),
        catch: (cause) =>
          cause instanceof PackError ? cause.message : "The pack could not be read.",
      }).pipe(Effect.result);
      if (verified._tag === "Failure") return refused(verified.failure);
      const name = verified.success.name;
      return yield* acceptPack({
        driveId: input.driveId,
        threadId: input.threadId,
        pack: verified.success,
        size: pack.size,
        // The index goes last: a pack without its index is never read.
        store: Effect.andThen(
          copy(packKey, drivePackKey(input.driveId, name, "pack", prefix)),
          copy(idxKey, drivePackKey(input.driveId, name, "idx", prefix)),
        ),
        ...(input.remoteHead === undefined ? {} : { remoteHead: input.remoteHead }),
        ...(input.remoteCommits === undefined ? {} : { remoteCommits: input.remoteCommits }),
        ...(input.promisedSizes === undefined ? {} : { promisedSizes: input.promisedSizes }),
        ...(input.private === true ? { private: true } : {}),
      });
    });
    // Stored or refused, the upload is done with. A failure keeps it for the machine's
    // retry; the lifecycle rule clears what nobody comes back for.
    yield* attempt("delete", () => bucket.delete([packKey, idxKey])).pipe(Effect.ignore);
    return answer;
  });

  return { offer, commit };
};

export type DirectUploads = ReturnType<typeof makeDirectUploads>;
