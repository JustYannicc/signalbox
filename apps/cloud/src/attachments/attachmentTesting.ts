// @effect-diagnostics globalDate:off - R2 dates its objects with `Date`, and so does this stand-in.
import type { AttachmentObjects } from "./attachmentObjects.ts";

/** Attachments in memory, for tests. */
export const makeMemoryObjects = (): AttachmentObjects & {
  readonly keys: () => ReadonlyArray<string>;
  /** Backdates `key`, as if it was uploaded `ageMs` ago. */
  readonly age: (key: string, ageMs: number) => void;
} => {
  const objects = new Map<
    string,
    { bytes: Uint8Array; customMetadata: Record<string, string>; uploaded: Date }
  >();
  const read = async (value: ReadableStream | Uint8Array) =>
    value instanceof Uint8Array
      ? value.slice()
      : new Uint8Array(await new Response(value).arrayBuffer());
  return {
    keys: () => [...objects.keys()],
    age: (key, ageMs) => {
      const object = objects.get(key);
      if (object !== undefined) object.uploaded = new Date(Date.now() - ageMs);
    },
    put: async (key, value, options) => {
      objects.set(key, {
        bytes: await read(value),
        customMetadata: { ...options.customMetadata },
        uploaded: new Date(),
      });
    },
    get: async (key) => {
      const object = objects.get(key);
      if (object === undefined) return null;
      return {
        size: object.bytes.length,
        customMetadata: object.customMetadata,
        body: new Blob([object.bytes.slice()]).stream(),
      };
    },
    head: async (key) => {
      const object = objects.get(key);
      return object === undefined
        ? null
        : {
            size: object.bytes.length,
            customMetadata: object.customMetadata,
            uploaded: object.uploaded,
          };
    },
    delete: async (keys) => {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
    list: async ({ prefix }) => ({
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, uploaded: object.uploaded })),
      truncated: false,
    }),
  };
};
