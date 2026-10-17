import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Bytes } from "./git/gitObjects.ts";

/**
 * Where drives' packs live: R2, in the EU jurisdiction, under
 * `<preview prefix><drive id>/packs/pack-<name>.{pack,idx}`. Packs are
 * immutable and named by their checksum, so writing one twice writes the same
 * bytes, and anything read from one can be cached for good.
 */

export class DrivePackError extends Schema.TaggedError<DrivePackError>()("DrivePackError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type PackFile = "pack" | "idx";

export class DrivePacks extends Context.Service<
  DrivePacks,
  {
    readonly put: (input: {
      readonly driveId: string;
      readonly name: string;
      readonly idx: Bytes;
      readonly pack: Bytes;
    }) => Effect.Effect<void, DrivePackError>;
    /** A whole file, streamed; null when there is none. */
    readonly get: (
      driveId: string,
      name: string,
      file: PackFile,
    ) => Effect.Effect<
      { readonly body: ReadableStream<Bytes>; readonly size: number } | null,
      DrivePackError
    >;
    /** `length` bytes of a pack from `offset`. */
    readonly range: (
      driveId: string,
      name: string,
      offset: number,
      length: number,
    ) => Effect.Effect<Bytes, DrivePackError>;
    /** Removes both files for each immutable pack. Safe to repeat after a partial R2 delete. */
    readonly remove: (
      driveId: string,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<void, DrivePackError>;
    /** Stores an immutable purge/tombstone snapshot in R2. Identical retries use the same key. */
    readonly writePurgeManifest: (input: {
      readonly driveId: string;
      readonly purgeId: string;
      readonly stage: "purge" | "gc";
      readonly contents: Bytes;
    }) => Effect.Effect<void, DrivePackError>;
  }
>()("@signalbox/cloud/drive/DrivePacks") {}

export const drivePackPrefix = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return "";
  const prefix = value.trim();
  if (!/^pr-[1-9]\d*\/?$/u.test(prefix)) {
    throw new Error("DRIVE_PACKS_PREFIX must be empty or a PR prefix such as pr-123/.");
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
};

export const drivePackKey = (driveId: string, name: string, file: PackFile, prefix = "") =>
  `${prefix}${driveId}/packs/pack-${name}.${file}`;

/** Purge ids are encoded byte-for-byte so they cannot add path segments to an R2 key. */
export const safePurgeId = (purgeId: string) =>
  Array.from(new TextEncoder().encode(purgeId), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

/** A content-addressed snapshot; future R2 rebuilds must replay these tombstones after refs (#494). */
export const drivePurgeManifestKey = (
  driveId: string,
  purgeId: string,
  stage: "purge" | "gc",
  sha256: string,
  prefix = "",
) => `${prefix}${driveId}/purges/${safePurgeId(purgeId)}/${stage}-${sha256}.json`;

/** The slice of an R2 bucket binding drives use. */
export interface PackBucket {
  readonly put: (key: string, value: Bytes) => Promise<unknown>;
  readonly get: (
    key: string,
    options?: { readonly range?: { readonly offset: number; readonly length: number } },
  ) => Promise<{
    readonly body: ReadableStream<Bytes>;
    readonly size: number;
    readonly arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;
  readonly delete: (keys: Array<string>) => Promise<unknown>;
}

export const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DrivePackError({ operation, cause }) });

export const layerBucket = (bucket: PackBucket, prefixValue?: string) => {
  const prefix = drivePackPrefix(prefixValue);
  // Previews deployed before PR prefixes wrote unprefixed keys; they still read
  // those until the legacy cleanup (docs/operations/cloud.md). Writes stay prefixed.
  const read = async (
    driveId: string,
    name: string,
    file: PackFile,
    options?: { readonly range: { readonly offset: number; readonly length: number } },
  ) =>
    (await bucket.get(drivePackKey(driveId, name, file, prefix), options)) ??
    (prefix === "" ? null : await bucket.get(drivePackKey(driveId, name, file), options));
  return Layer.succeed(
    DrivePacks,
    DrivePacks.of({
      // The index goes last: a pack without its index is never read.
      put: ({ driveId, name, idx, pack }) =>
        attempt("put", async () => {
          await bucket.put(drivePackKey(driveId, name, "pack", prefix), pack);
          await bucket.put(drivePackKey(driveId, name, "idx", prefix), idx);
        }),
      get: (driveId, name, file) =>
        attempt("get", async () => {
          const object = await read(driveId, name, file);
          return object === null ? null : { body: object.body, size: object.size };
        }),
      range: (driveId, name, offset, length) =>
        attempt("range", async () => {
          const object = await read(driveId, name, "pack", { range: { offset, length } });
          if (object === null) throw new Error(`Pack ${name} is missing.`);
          return new Uint8Array(await object.arrayBuffer());
        }),
      remove: (driveId, names) =>
        attempt("remove", async () => {
          const keys = names.flatMap((name) => [
            drivePackKey(driveId, name, "pack", prefix),
            drivePackKey(driveId, name, "idx", prefix),
            ...(prefix === ""
              ? []
              : [drivePackKey(driveId, name, "pack"), drivePackKey(driveId, name, "idx")]),
          ]);
          // R2 accepts at most 1,000 keys per bulk delete request.
          for (let at = 0; at < keys.length; at += 1_000) {
            await bucket.delete(keys.slice(at, at + 1_000));
          }
        }),
      writePurgeManifest: ({ driveId, purgeId, stage, contents }) =>
        attempt("writePurgeManifest", async () => {
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", contents));
          const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
          const key = drivePurgeManifestKey(driveId, purgeId, stage, hash, prefix);
          await bucket.put(key, contents);
        }),
    }),
  );
};

/** Packs in memory, for tests. */
export const makeMemoryBucket = (): PackBucket & { readonly keys: () => ReadonlyArray<string> } => {
  const files = new Map<string, Bytes>();
  return {
    keys: () => [...files.keys()],
    put: async (key, value) => {
      files.set(key, value.slice());
    },
    delete: async (keys) => {
      for (const key of keys) files.delete(key);
    },
    get: async (key, options) => {
      const file = files.get(key);
      if (file === undefined) return null;
      const bytes =
        options?.range === undefined
          ? file
          : file.subarray(options.range.offset, options.range.offset + options.range.length);
      return {
        size: file.length,
        body: new Blob([bytes]).stream(),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
  };
};
