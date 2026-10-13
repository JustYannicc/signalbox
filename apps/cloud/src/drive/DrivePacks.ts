import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Bytes } from "./git/gitObjects.ts";

/**
 * Where drives' packs live: R2, in the EU jurisdiction, under
 * `<drive id>/packs/pack-<name>.{pack,idx}`. Packs are immutable and named by
 * their checksum, so writing one twice writes the same bytes, and anything
 * read from one can be cached for good.
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
  }
>()("@signalbox/cloud/drive/DrivePacks") {}

const packKey = (driveId: string, name: string, file: PackFile) =>
  `${driveId}/packs/pack-${name}.${file}`;

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
}

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DrivePackError({ operation, cause }) });

export const layerBucket = (bucket: PackBucket) =>
  Layer.succeed(
    DrivePacks,
    DrivePacks.of({
      // The index goes last: a pack without its index is never read.
      put: ({ driveId, name, idx, pack }) =>
        attempt("put", async () => {
          await bucket.put(packKey(driveId, name, "pack"), pack);
          await bucket.put(packKey(driveId, name, "idx"), idx);
        }),
      get: (driveId, name, file) =>
        attempt("get", async () => {
          const object = await bucket.get(packKey(driveId, name, file));
          return object === null ? null : { body: object.body, size: object.size };
        }),
      range: (driveId, name, offset, length) =>
        attempt("range", async () => {
          const object = await bucket.get(packKey(driveId, name, "pack"), {
            range: { offset, length },
          });
          if (object === null) throw new Error(`Pack ${name} is missing.`);
          return new Uint8Array(await object.arrayBuffer());
        }),
    }),
  );

/** Packs in memory, for tests. */
export const makeMemoryBucket = (): PackBucket & { readonly keys: () => ReadonlyArray<string> } => {
  const files = new Map<string, Bytes>();
  return {
    keys: () => [...files.keys()],
    put: async (key, value) => {
      files.set(key, value.slice());
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
