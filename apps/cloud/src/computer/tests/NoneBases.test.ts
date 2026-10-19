import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { NoneBases } from "../adapters/NoneBases.ts";
import type { BaseLease, DriveRef, RecipeHash } from "../Computer.ts";

describe("NoneBases", () => {
  it("returns no lease for a drive and recipe", async () => {
    const drive = "my/personal/alice" as DriveRef;
    const recipeHash = "sha256:abc" as RecipeHash;

    const lease = await Effect.runPromise(NoneBases.acquire(drive, recipeHash));

    expect(Option.isNone(lease)).toBe(true);
  });

  it("releases a lease as a no-op", async () => {
    const lease: BaseLease = {
      id: "lease-1",
      sourceRef: "opaque-source",
      expiresAt: 1_800_000_000_000,
    };

    await expect(Effect.runPromise(NoneBases.release(lease))).resolves.toBeUndefined();
  });
});
