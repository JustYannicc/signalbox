import {
  type DirectUploadOffer,
  MAX_DIRECT_PACK_BYTES,
} from "@signalbox/runner-protocol/DriveProtocol";
import { AwsClient } from "aws4fetch";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

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
 *    `URL_SECONDS`, for `incoming/<preview prefix><drive>/<upload>.{pack,idx}`.
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

const URL_SECONDS = 15 * 60;
/** The index is read whole and expanded: about 850,000 objects, well inside an isolate. */
const MAX_IDX_BYTES = 24 * 1024 * 1024;

/** S3 access to the bucket drives' packs live in: R2's S3 API. */
export interface DirectUploadsEnv {
  readonly DRIVE_PACKS_S3_ACCESS_KEY_ID?: string;
  readonly DRIVE_PACKS_S3_SECRET_ACCESS_KEY?: string;
  /** `https://<account>.eu.r2.cloudflarestorage.com` for the EU jurisdiction. */
  readonly DRIVE_PACKS_S3_ENDPOINT?: string;
  /** The packs bucket's name, as `DRIVE_PACKS` binds it. */
  readonly DRIVE_PACKS_BUCKET_NAME?: string;
}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? null : value.trim();

/** Under one top-level `incoming/` in every bucket, so one lifecycle rule clears what nobody committed. */
export const incomingKey = (driveId: string, uploadId: string, file: "pack" | "idx", prefix = "") =>
  `incoming/${prefix}${driveId}/${uploadId}.${file}`;

/** What direct uploads need of storage beyond the bucket binding. */
export interface DirectStorage {
  /** A URL anyone may `PUT` the object at `key` to, for a little while. */
  readonly presignPut: (key: string) => Promise<string>;
  /** Copies `from` to `to` within the bucket, the bytes never passing through here. */
  readonly copy: (from: string, to: string) => Promise<void>;
}

/** The packs bucket through R2's S3 API; null without credentials. */
export const s3Storage = (env: DirectUploadsEnv): DirectStorage | null => {
  const accessKeyId = nonEmpty(env.DRIVE_PACKS_S3_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(env.DRIVE_PACKS_S3_SECRET_ACCESS_KEY);
  const endpoint = nonEmpty(env.DRIVE_PACKS_S3_ENDPOINT)?.replace(/\/+$/, "") ?? null;
  const bucketName = nonEmpty(env.DRIVE_PACKS_BUCKET_NAME);
  if (
    accessKeyId === null ||
    secretAccessKey === null ||
    endpoint === null ||
    bucketName === null
  ) {
    return null;
  }
  const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const path = (key: string) =>
    `/${bucketName}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    presignPut: async (key) => {
      const url = new URL(`${endpoint}${path(key)}`);
      url.searchParams.set("X-Amz-Expires", String(URL_SECONDS));
      const signed = await s3.sign(new Request(url, { method: "PUT" }), {
        aws: { signQuery: true },
      });
      return signed.url;
    },
    copy: async (from, to) => {
      const response = await s3.fetch(`${endpoint}${path(to)}`, {
        method: "PUT",
        headers: { "x-amz-copy-source": path(from) },
      });
      // S3 may answer a failed copy with 200 and an error in the body.
      const body = await response.text();
      if (!response.ok || body.includes("<Error>")) {
        throw new Error(`Copying an upload answered ${response.status}.`);
      }
    },
  };
};

export const makeDirectUploads = (input: {
  readonly bucket: PackBucket;
  readonly storage: DirectStorage;
  readonly prefix?: string | undefined;
}) => {
  const { bucket, storage } = input;
  const prefix = drivePackPrefix(input.prefix);
  const presignPut = (key: string) => attempt("presign", () => storage.presignPut(key));
  const copy = (from: string, to: string) => attempt("copy", () => storage.copy(from, to));

  const offer = Effect.fn("DirectUploads.offer")(function* (
    driveId: string,
    request: { readonly packSize: number; readonly idxSize: number },
  ) {
    if (request.packSize > MAX_DIRECT_PACK_BYTES || request.idxSize > MAX_IDX_BYTES) {
      return { _tag: "too_large" } as const;
    }
    const uploadId = yield* Effect.orDie((yield* Crypto.Crypto).randomUUIDv4());
    const [pack, idx] = yield* Effect.all(
      [
        presignPut(incomingKey(driveId, uploadId, "pack", prefix)),
        presignPut(incomingKey(driveId, uploadId, "idx", prefix)),
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
    readonly promisedSizes?: Effect.Effect<ReadonlyMap<Oid, number>, never, R>;
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
      if (idx.size > MAX_IDX_BYTES) {
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
        ...(input.promisedSizes === undefined ? {} : { promisedSizes: input.promisedSizes }),
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
