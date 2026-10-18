import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: unknown;
    constructor(ctx: unknown) {
      this.ctx = ctx;
    }
  },
}));
vi.mock("./SqliteSearchIndex.ts", () => ({
  layer: () => {
    throw new Error("index initialization failed");
  },
  initialize: () => {
    throw new Error("conversion failed");
  },
}));

import { SearchIndexObject, homeName, layerFromEnv } from "./CloudflareSearchIndex.ts";
import * as SearchIndex from "./SearchIndex.ts";

const home = { ownerId: "owner", projectId: "scratch" };

describe("Cloudflare search controls", () => {
  it("preserves generation 1 names and isolates replacement generations", () => {
    expect(homeName(home)).toBe('["owner","scratch"]');
    expect(homeName(home, "repair-a")).toBe('["search","repair-a","owner","scratch"]');
  });

  it("disables the object before a broken index initialization or conversion can run", async () => {
    // Disabled construction must not even read storage or object identity.
    const state = new Proxy({} as DurableObjectState, {
      get: () => {
        throw new Error("disabled object touched storage");
      },
    });
    const object = new SearchIndexObject(state, {
      LOCAL_WORKERD: "1",
      SEARCH_INDEX_DISABLED: "1",
    });
    await object.alarm();
    await expect(object.progress(home, [])).rejects.toMatchObject({
      _tag: "SearchIndexError",
      operation: "disabled",
    });
  });

  it("leaves an inactive old generation untouched when its retained alarm wakes", async () => {
    const state = new Proxy({} as DurableObjectState, {
      get: (_target, property) => {
        if (property === "id") return { name: homeName(home) };
        throw new Error("inactive generation touched storage");
      },
    });
    const object = new SearchIndexObject(state, {
      LOCAL_WORKERD: "1",
      SEARCH_INDEX_GENERATION: "repair-a",
    });
    await object.alarm();
    await expect(object.progress(home, [])).rejects.toMatchObject({
      _tag: "SearchIndexError",
      operation: "disabled",
    });
  });

  it.effect("refuses disabled transport calls before obtaining any index object", () =>
    Effect.gen(function* () {
      const index = yield* SearchIndex.SearchIndex;
      const result = yield* Effect.result(index.progress(home, ["thread"]));
      expect(result._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        layerFromEnv({
          SEARCH_INDEX_DISABLED: "1",
          SEARCH_INDEX: {
            get: () => {
              throw new Error("disabled search obtained an object");
            },
            idFromName: () => {
              throw new Error("disabled search resolved a name");
            },
            jurisdiction: () => {
              throw new Error("disabled search resolved a jurisdiction");
            },
          },
        }),
      ),
    ),
  );
});
