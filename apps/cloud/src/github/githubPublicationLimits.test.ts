import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { publicationFixture } from "./githubPublicationTesting.ts";

// Small limits exercise the production preflight without allocating a 100 MB test file.
const { limits } = vi.hoisted(() => ({
  limits: { host: "GitHub", maxFileBytes: 100_000, maxPushBytes: 100_000 },
}));
vi.mock("../drive/gitPush.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../drive/gitPush.ts")>()),
  GITHUB_LIMITS: limits,
}));

describe("cloud publication limits", () => {
  it.effect("checks historical file sizes before creating or binding", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      const before = yield* f.drive.refs("existing-thread");
      limits.maxFileBytes = 8;
      limits.maxPushBytes = 100_000;
      const error = yield* f.publish().pipe(Effect.flip);
      expect(error.message).toContain("old.txt");
      expect(error.message).toContain("too big");
      expect(f.creations).toHaveLength(0);
      expect(f.receiveCalls()).toHaveLength(0);
      expect(yield* f.drive.refs("existing-thread")).toEqual(before);
    }),
  );

  it.effect("checks total push size before creating or binding", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      const before = yield* f.drive.refs("existing-thread");
      limits.maxFileBytes = 100_000;
      limits.maxPushBytes = 1;
      const error = yield* f.publish().pipe(Effect.flip);
      expect(error.message).toContain("This push is");
      expect(f.creations).toHaveLength(0);
      expect(f.receiveCalls()).toHaveLength(0);
      expect(yield* f.drive.refs("existing-thread")).toEqual(before);
    }),
  );
});
