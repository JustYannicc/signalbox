import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  layer as previewCleanupLayer,
  PreviewCleanupService,
  type PreviewCleanupDependencies,
  type PreviewCleanupCommand,
} from "./PreviewCleanupService.ts";
import { handlePreviewCleanup } from "./previewCleanup.ts";
import type {
  PreviewLinkRegistryApi,
  PreviewLinkRegistryNamespace,
} from "../pool/PreviewLinkRegistry.ts";

const memoryBucket = (initial: ReadonlyArray<string>, pageSize = 1000) => {
  const keys = new Set(initial);
  return {
    keys: () => [...keys].sort(),
    list: async (options?: {
      readonly prefix?: string;
      readonly delimiter?: string;
      readonly cursor?: string;
      readonly limit?: number;
    }) => {
      const prefix = options?.prefix ?? "";
      const delimiter = options?.delimiter;
      const all = [...keys]
        .filter((key) => key.startsWith(prefix) && (!options?.cursor || key > options.cursor))
        .sort();
      if (delimiter !== undefined) {
        const objects = new Set<string>();
        const delimitedPrefixes = new Set<string>();
        for (const key of all) {
          const rest = key.slice(prefix.length);
          const index = rest.indexOf(delimiter);
          if (index === -1) objects.add(key);
          else delimitedPrefixes.add(`${prefix}${rest.slice(0, index + delimiter.length)}`);
        }
        return {
          objects: [...objects].map((key) => ({ key })),
          delimitedPrefixes: [...delimitedPrefixes],
          truncated: false,
          cursor: "",
        };
      }
      const limit = options?.limit ?? pageSize;
      const page = all.slice(0, limit);
      const truncated = all.length > page.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? (page.at(-1) ?? "") : "",
      };
    },
    delete: async (deleted: string[]) => {
      for (const key of deleted) keys.delete(key);
    },
  };
};

const cleanupRequest = (body: unknown) =>
  new Request("https://app.signalbox.run/api/internal/preview-cleanup", {
    method: "POST",
    headers: { authorization: "Bearer cleanup-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const untouchedRegistry: PreviewLinkRegistryApi = {
  registerPool: async () => expect.unreachable(),
  cleanupOrigin: async () => expect.unreachable(),
  activateOrigin: async () => expect.unreachable(),
  listOrigins: async () => expect.unreachable(),
};

const emptyRegistry: PreviewLinkRegistryApi = {
  registerPool: async () => true,
  cleanupOrigin: async () => 0,
  activateOrigin: async () => {},
  listOrigins: async () => [],
};

const cleanupDependencies = (
  bucket: NonNullable<PreviewCleanupDependencies["drivePacks"]>,
  registry: PreviewLinkRegistryApi = emptyRegistry,
): PreviewCleanupDependencies => ({
  drivePacks: bucket,
  links: {
    idFromName: () => ({}) as DurableObjectId,
    get: () => registry,
  } as PreviewLinkRegistryNamespace,
});

const cleanupEnv = (bucket: ReturnType<typeof memoryBucket>) => ({
  PREVIEW_CLEANUP_TOKEN: "cleanup-token",
  PREVIEW_DRIVE_PACKS: bucket,
  PREVIEW_LINKS: cleanupDependencies(bucket, untouchedRegistry).links,
});

const runCleanup = (command: PreviewCleanupCommand, dependencies: PreviewCleanupDependencies) =>
  Effect.gen(function* () {
    const cleanup = yield* PreviewCleanupService;
    return yield* cleanup.cleanup(command);
  }).pipe(Effect.provide(previewCleanupLayer(dependencies)));

describe("preview drive pack cleanup", () => {
  it.effect("lists PR prefixes and deletes only the requested prefix", () =>
    Effect.gen(function* () {
      const bucket = memoryBucket(
        [
          "pr-21/drive/packs/pack-a.idx",
          "pr-21/drive/packs/pack-a.pack",
          "pr-212/drive/packs/pack-b.pack",
          "pr-212/drive/packs/pack-b.idx",
          "drive/packs/pack-old.pack",
        ],
        1,
      );
      const dependencies = cleanupDependencies(bucket);
      expect(yield* runCleanup({ action: "list" }, dependencies)).toEqual({
        prNumbers: [21, 212],
      });
      expect(yield* runCleanup({ action: "delete", pullRequestNumber: 21 }, dependencies)).toEqual({
        ok: true,
        linksRemoved: 0,
        packsRemoved: 2,
      });
      expect(bucket.keys()).toEqual([
        "drive/packs/pack-old.pack",
        "pr-212/drive/packs/pack-b.idx",
        "pr-212/drive/packs/pack-b.pack",
      ]);
    }),
  );

  it.effect("removes legacy unprefixed packs and preserves every PR namespace", () =>
    Effect.gen(function* () {
      const bucket = memoryBucket(
        [
          "drive-a/packs/pack-old.pack",
          "pr-12/drive/packs/pack-a.pack",
          "pr-213/drive/packs/pack-b.idx",
        ],
        1,
      );
      expect(
        yield* runCleanup({ action: "clear-legacy-packs" }, cleanupDependencies(bucket)),
      ).toEqual({ ok: true, packsRemoved: 1 });
      expect(bucket.keys()).toEqual([
        "pr-12/drive/packs/pack-a.pack",
        "pr-213/drive/packs/pack-b.idx",
      ]);
    }),
  );

  it.effect("fails a truncated R2 page that has no cursor", () => {
    let calls = 0;
    const bucket = {
      list: async () => {
        calls += 1;
        return { objects: [], truncated: true, cursor: "" };
      },
      delete: async () => {},
    };
    return Effect.gen(function* () {
      const error = yield* Effect.flip(runCleanup({ action: "list" }, cleanupDependencies(bucket)));
      expect(error._tag).toBe("PreviewPackCursorMissingError");
      expect(calls).toBe(1);
    });
  });

  it("is not found while production has no cleanup token", async () => {
    const { PREVIEW_CLEANUP_TOKEN: _, ...env } = cleanupEnv(memoryBucket([]));
    const response = await handlePreviewCleanup(cleanupRequest({ action: "list" }), env);
    expect(response.status).toBe(404);
  });

  it.each([
    ["a zero PR number", { action: "delete", pullRequestNumber: 0 }],
    ["a negative PR number", { action: "delete", pullRequestNumber: -1 }],
    ["a fractional PR number", { action: "activate", pullRequestNumber: 1.5 }],
    ["a path in the PR number", { action: "delete", pullRequestNumber: "1/../" }],
    ["no pool objects", { action: "delete-links", pullRequestNumber: 1, poolObjectIds: [] }],
    [
      "more than 100 pool objects",
      {
        action: "delete-links",
        pullRequestNumber: 1,
        poolObjectIds: Array.from({ length: 101 }, (_, index) => `pool-${index}`),
      },
    ],
  ])("rejects %s", async (_, body) => {
    const bucket = memoryBucket(["pr-1/drive/packs/pack-a.pack"]);
    const response = await handlePreviewCleanup(cleanupRequest(body), cleanupEnv(bucket));
    expect(response.status).toBe(400);
    expect(bucket.keys()).toEqual(["pr-1/drive/packs/pack-a.pack"]);
  });

  it("requires the cleanup token and removes only the requested preview state", async () => {
    const bucket = memoryBucket([
      "pr-212/drive/packs/pack-a.pack",
      "pr-213/drive/packs/pack-b.pack",
      "legacy-drive/packs/pack-old.idx",
    ]);
    const removedOrigins: Array<string> = [];
    const registry: PreviewLinkRegistryApi = {
      registerPool: async () => true,
      cleanupOrigin: async (origin, poolObjectIds = []) => {
        removedOrigins.push(origin);
        return poolObjectIds.length || 2;
      },
      activateOrigin: async () => {},
      listOrigins: async () => [],
    };
    const env = {
      PREVIEW_CLEANUP_TOKEN: "cleanup-token",
      PREVIEW_DRIVE_PACKS: bucket,
      PREVIEW_LINKS: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => registry,
      } as PreviewLinkRegistryNamespace,
    };
    const request = (authorization: string) =>
      new Request("https://app.signalbox.run/api/internal/preview-cleanup", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", pullRequestNumber: 212 }),
      });

    expect((await handlePreviewCleanup(request("Bearer wrong"), env)).status).toBe(401);
    const backfillResponse = await handlePreviewCleanup(
      new Request("https://app.signalbox.run/api/internal/preview-cleanup", {
        method: "POST",
        headers: { authorization: "Bearer cleanup-token", "content-type": "application/json" },
        body: JSON.stringify({
          action: "delete-links",
          pullRequestNumber: 212,
          poolObjectIds: ["pool-object-id"],
        }),
      }),
      env,
    );
    expect(await backfillResponse.json()).toEqual({ ok: true, linksRemoved: 1 });
    const response = await handlePreviewCleanup(request("Bearer cleanup-token"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, linksRemoved: 2, packsRemoved: 1 });
    expect(removedOrigins).toEqual([
      "https://preview-212.signalbox.run",
      "https://preview-212.signalbox.run",
    ]);
    expect(bucket.keys()).toEqual([
      "legacy-drive/packs/pack-old.idx",
      "pr-213/drive/packs/pack-b.pack",
    ]);
  });
});
