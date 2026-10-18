import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  previewLinkRegistry,
  type PreviewLinkRegistryNamespace,
} from "../pool/PreviewLinkRegistry.ts";

interface PreviewPackListOptions {
  readonly prefix?: string;
  readonly delimiter?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

interface PreviewPackPage {
  readonly objects: ReadonlyArray<{ readonly key: string }>;
  readonly delimitedPrefixes?: ReadonlyArray<string>;
  readonly truncated: boolean;
  readonly cursor: string;
}

interface PreviewPackBucket {
  readonly list: (options?: PreviewPackListOptions) => Promise<PreviewPackPage>;
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

type PreviewCleanupOperation =
  | "bindings"
  | "list-links"
  | "activate-links"
  | "delete-links"
  | "list-packs"
  | "delete-packs";

export class PreviewCleanupError extends Schema.TaggedError<PreviewCleanupError>()(
  "PreviewCleanupError",
  {
    operation: Schema.Literals([
      "bindings",
      "list-links",
      "activate-links",
      "delete-links",
      "list-packs",
      "delete-packs",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.operation === "bindings"
      ? "Preview cleanup bindings are unavailable."
      : `Preview cleanup ${this.operation} failed.`;
  }
}

export class PreviewPackCursorMissingError extends Schema.TaggedError<PreviewPackCursorMissingError>()(
  "PreviewPackCursorMissingError",
  {},
) {
  override get message() {
    return "R2 returned a truncated page without a cursor.";
  }
}

const cleanupOperation = <A>(operation: PreviewCleanupOperation, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PreviewCleanupError({ operation, cause }),
  });

const previewNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

const previewOrigin = (number: number) => `https://preview-${number}.signalbox.run`;
const previewPrefix = (number: number) => `pr-${number}/`;

const listPages = (bucket: PreviewPackBucket, options: Omit<PreviewPackListOptions, "cursor">) =>
  Stream.paginate<
    { readonly cursor?: string },
    PreviewPackPage,
    PreviewCleanupError | PreviewPackCursorMissingError
  >({}, ({ cursor }) =>
    cleanupOperation("list-packs", () =>
      bucket.list({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    ).pipe(
      Effect.flatMap((page) => {
        if (page.truncated && !page.cursor) {
          return Effect.fail(new PreviewPackCursorMissingError());
        }
        return Effect.succeed([
          [page],
          page.truncated ? Option.some({ cursor: page.cursor }) : Option.none(),
        ] as const);
      }),
    ),
  );

export const removePreviewPackPrefix = (bucket: PreviewPackBucket, prefix: string) =>
  Effect.gen(function* () {
    const removed = yield* Ref.make(0);
    yield* listPages(bucket, { prefix, limit: 1000 }).pipe(
      Stream.runForEach((page) => {
        const keys = page.objects.map((object) => object.key);
        if (keys.length === 0) return Effect.void;
        return cleanupOperation("delete-packs", () => bucket.delete(keys)).pipe(
          Effect.tap(() => Ref.update(removed, (count) => count + keys.length)),
        );
      }),
    );
    return yield* Ref.get(removed);
  });

export const listPreviewPackNumbers = (bucket: PreviewPackBucket) =>
  Effect.gen(function* () {
    const numbers = yield* Ref.make(new Set<number>());
    yield* listPages(bucket, { prefix: "pr-", delimiter: "/", limit: 1000 }).pipe(
      Stream.runForEach((page) =>
        Ref.update(numbers, (current) => {
          const next = new Set(current);
          for (const prefix of page.delimitedPrefixes ?? []) {
            const match = /^pr-([1-9]\d*)\/$/u.exec(prefix);
            const number = match?.[1] === undefined ? null : previewNumber(Number(match[1]));
            if (number !== null) next.add(number);
          }
          return next;
        }),
      ),
    );
    return [...(yield* Ref.get(numbers))].sort((left, right) => left - right);
  });

export const removeLegacyPreviewPacks = (bucket: PreviewPackBucket) =>
  Effect.gen(function* () {
    const removed = yield* Ref.make(0);
    yield* listPages(bucket, { limit: 1000 }).pipe(
      Stream.runForEach((page) => {
        const keys = page.objects
          .map((object) => object.key)
          .filter((key) => !/^pr-[1-9]\d*\//u.test(key));
        if (keys.length === 0) return Effect.void;
        return cleanupOperation("delete-packs", () => bucket.delete(keys)).pipe(
          Effect.tap(() => Ref.update(removed, (count) => count + keys.length)),
        );
      }),
    );
    return yield* Ref.get(removed);
  });

/** Executes one already-decoded cleanup operation against production storage and link state. */
export const runPreviewCleanup = (command: PreviewCleanupCommand, env: PreviewCleanupBindings) =>
  Effect.gen(function* () {
    if (env.PREVIEW_DRIVE_PACKS === undefined || env.PREVIEW_LINKS === undefined) {
      return yield* new PreviewCleanupError({ operation: "bindings" });
    }
    const bucket = env.PREVIEW_DRIVE_PACKS;
    const links = previewLinkRegistry(env.PREVIEW_LINKS);

    switch (command.action) {
      case "list": {
        const origins = yield* cleanupOperation("list-links", () => links.listOrigins());
        const numbers = origins.flatMap((origin) => {
          const match = /^https:\/\/preview-([1-9]\d*)\.signalbox\.run$/u.exec(origin);
          const number = match?.[1] === undefined ? null : previewNumber(Number(match[1]));
          return number === null ? [] : [number];
        });
        const packs = yield* listPreviewPackNumbers(bucket);
        return { prNumbers: [...new Set([...numbers, ...packs])] };
      }
      case "activate":
        yield* cleanupOperation("activate-links", () =>
          links.activateOrigin(previewOrigin(command.pullRequestNumber)),
        );
        return { ok: true };
      case "delete-links": {
        const linksRemoved = yield* cleanupOperation("delete-links", () =>
          links.cleanupOrigin(previewOrigin(command.pullRequestNumber), command.poolObjectIds),
        );
        return { ok: true, linksRemoved };
      }
      case "delete": {
        const origin = previewOrigin(command.pullRequestNumber);
        const linksRemoved = yield* cleanupOperation("delete-links", () =>
          links.cleanupOrigin(origin),
        );
        const packsRemoved = yield* removePreviewPackPrefix(
          bucket,
          previewPrefix(command.pullRequestNumber),
        );
        return { ok: true, linksRemoved, packsRemoved };
      }
      case "clear-legacy-packs":
        return { ok: true, packsRemoved: yield* removeLegacyPreviewPacks(bucket) };
    }
  });
