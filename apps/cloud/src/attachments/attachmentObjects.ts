import { drivePackPrefix } from "../drive/DrivePacks.ts";

/**
 * The slice of an R2 bucket attachments use. Each object's custom metadata
 * says what it is, set when the bytes land and never taken from a later client.
 */

export interface AttachmentObjectMeta {
  readonly customMetadata?: Record<string, string> | undefined;
  readonly size: number;
}

export interface AttachmentObjects {
  readonly put: (
    key: string,
    value: ReadableStream | Uint8Array,
    options: { readonly customMetadata: Record<string, string> },
  ) => Promise<unknown>;
  readonly get: (
    key: string,
  ) => Promise<(AttachmentObjectMeta & { readonly body: ReadableStream<Uint8Array> }) | null>;
  readonly head: (key: string) => Promise<AttachmentObjectMeta | null>;
  readonly delete: (keys: string | string[]) => Promise<unknown>;
  readonly list: (options: {
    readonly prefix: string;
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string; readonly uploaded: Date }>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

/**
 * `body` cut to exactly `size` bytes: R2 needs a stream's length up front, and
 * a body that is shorter or longer fails the write instead of storing it.
 * Workers only; tests store bytes as they come.
 */
export const exactly = (body: ReadableStream<Uint8Array>, size: number) =>
  typeof FixedLengthStream === "undefined" ? body : body.pipeThrough(new FixedLengthStream(size));

/** Where attachments live: the drives bucket, under its preview prefix. */
export interface AttachmentStorage {
  readonly objects: AttachmentObjects;
  readonly prefix: string;
}

/**
 * A deployment's attachment storage, from the drives bucket binding and its
 * preview prefix (`DRIVE_PACKS_PREFIX`). Without the bucket nothing stores.
 */
export const attachmentStorage = (env: {
  readonly DRIVE_PACKS?: AttachmentObjects | undefined;
  readonly DRIVE_PACKS_PREFIX?: string | undefined;
}): AttachmentStorage => ({
  objects: env.DRIVE_PACKS ?? noObjects,
  prefix: drivePackPrefix(env.DRIVE_PACKS_PREFIX),
});

/** A cloud without a bucket: nothing stores, nothing is found. Clients aren't offered uploads there. */
export const noObjects: AttachmentObjects = {
  put: () => Promise.reject(new Error("This cloud stores no attachments.")),
  get: async () => null,
  head: async () => null,
  delete: async () => undefined,
  list: async () => ({ objects: [], truncated: false }),
};
