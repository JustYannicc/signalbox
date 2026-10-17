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
    /** The same bytes as `range`, streamed rather than held. */
    readonly stream: (
      driveId: string,
      name: string,
      offset: number,
      length: number,
    ) => Effect.Effect<ReadableStream<Bytes>, DrivePackError>;
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
      stream: (driveId, name, offset, length) =>
        attempt("stream", async () => {
          const object = await read(driveId, name, "pack", { range: { offset, length } });
          if (object === null) throw new Error(`Pack ${name} is missing.`);
          return object.body;
        }),
    }),
  );
};

/** `bytes` read 64 KiB at a time as they're asked for, as R2 streams a body. */
const piecewise = (bytes: Bytes) => {
  let at = 0;
  return new ReadableStream<Bytes>({
    pull: (controller) => {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, (at += 64 * 1024)));
    },
  });
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
        body: piecewise(bytes),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
  };
};
