import {
  previewLinkRegistry,
  type PreviewLinkRegistryNamespace,
} from "../pool/PreviewLinkRegistry.ts";

interface PreviewPackBucket {
  readonly list: (options?: {
    readonly prefix?: string;
    readonly delimiter?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly delimitedPrefixes?: ReadonlyArray<string>;
    readonly truncated: boolean;
    readonly cursor: string;
  }>;
  readonly delete: (keys: string[]) => Promise<unknown>;
}

export interface PreviewCleanupBindings {
  readonly PREVIEW_DRIVE_PACKS?: PreviewPackBucket;
  readonly PREVIEW_LINKS: PreviewLinkRegistryNamespace;
}

export type PreviewCleanupCommand =
  | { readonly action: "list" }
  | { readonly action: "activate"; readonly pullRequestNumber: number }
  | {
      readonly action: "delete-links";
      readonly pullRequestNumber: number;
      readonly poolObjectIds: ReadonlyArray<string>;
    }
  | { readonly action: "delete"; readonly pullRequestNumber: number }
  | { readonly action: "clear-legacy-packs" };

const previewNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

const previewOrigin = (number: number) => `https://preview-${number}.signalbox.run`;
const previewPrefix = (number: number) => `pr-${number}/`;

export const removePreviewPackPrefix = async (bucket: PreviewPackBucket, prefix: string) => {
  let cursor: string | undefined;
  let removed = 0;
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      removed += keys.length;
    }
    if (!page.truncated) return removed;
    if (!page.cursor) throw new Error("R2 returned a truncated page without a cursor.");
    cursor = page.cursor;
  }
};

export const listPreviewPackNumbers = async (bucket: PreviewPackBucket) => {
  let cursor: string | undefined;
  const numbers = new Set<number>();
  for (;;) {
    const page = await bucket.list({
      prefix: "pr-",
      delimiter: "/",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const prefix of page.delimitedPrefixes ?? []) {
      const match = /^pr-([1-9]\d*)\/$/u.exec(prefix);
      const number = match?.[1] === undefined ? null : previewNumber(Number(match[1]));
      if (number !== null) numbers.add(number);
    }
    if (!page.truncated) return [...numbers].sort((left, right) => left - right);
    if (!page.cursor) throw new Error("R2 returned a truncated page without a cursor.");
    cursor = page.cursor;
  }
};

export const removeLegacyPreviewPacks = async (bucket: PreviewPackBucket) => {
  let cursor: string | undefined;
  let removed = 0;
  for (;;) {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects
      .map((object) => object.key)
      .filter((key) => !/^pr-[1-9]\d*\//u.test(key));
    if (keys.length > 0) {
      await bucket.delete(keys);
      removed += keys.length;
    }
    if (!page.truncated) return removed;
    if (!page.cursor) throw new Error("R2 returned a truncated page without a cursor.");
    cursor = page.cursor;
  }
};

/** Executes one already-decoded cleanup operation against production storage and link state. */
export const runPreviewCleanup = async (
  command: PreviewCleanupCommand,
  env: PreviewCleanupBindings,
) => {
  if (env.PREVIEW_DRIVE_PACKS === undefined || env.PREVIEW_LINKS === undefined) {
    throw new Error("Preview cleanup bindings are unavailable.");
  }
  const bucket = env.PREVIEW_DRIVE_PACKS;
  const links = previewLinkRegistry(env.PREVIEW_LINKS);

  switch (command.action) {
    case "list": {
      const origins = await links.listOrigins();
      const numbers = origins.flatMap((origin) => {
        const match = /^https:\/\/preview-([1-9]\d*)\.signalbox\.run$/u.exec(origin);
        const number = match?.[1] === undefined ? null : previewNumber(Number(match[1]));
        return number === null ? [] : [number];
      });
      return {
        prNumbers: [...new Set([...numbers, ...(await listPreviewPackNumbers(bucket))])],
      };
    }
    case "activate":
      await links.activateOrigin(previewOrigin(command.pullRequestNumber));
      return { ok: true };
    case "delete-links": {
      const linksRemoved = await links.cleanupOrigin(
        previewOrigin(command.pullRequestNumber),
        command.poolObjectIds,
      );
      return { ok: true, linksRemoved };
    }
    case "delete": {
      const origin = previewOrigin(command.pullRequestNumber);
      const linksRemoved = await links.cleanupOrigin(origin);
      const packsRemoved = await removePreviewPackPrefix(
        bucket,
        previewPrefix(command.pullRequestNumber),
      );
      return { ok: true, linksRemoved, packsRemoved };
    }
    case "clear-legacy-packs":
      return { ok: true, packsRemoved: await removeLegacyPreviewPacks(bucket) };
  }
};
