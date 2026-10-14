import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DrivePacks from "./DrivePacks.ts";

describe("DrivePacks", () => {
  it.effect("namespaces preview packs while leaving production keys unchanged", () => {
    const previewBucket = DrivePacks.makeMemoryBucket();
    const input = {
      driveId: "drive-1",
      name: "012345",
      idx: new Uint8Array([1]),
      pack: new Uint8Array([2]),
    };
    return Effect.gen(function* () {
      const preview = yield* DrivePacks.DrivePacks;
      yield* preview.put(input);
      expect(previewBucket.keys()).toEqual([
        "pr-212/drive-1/packs/pack-012345.pack",
        "pr-212/drive-1/packs/pack-012345.idx",
      ]);
      expect(DrivePacks.drivePackKey("drive-1", "012345", "pack")).toBe(
        "drive-1/packs/pack-012345.pack",
      );
      expect(DrivePacks.drivePackPrefix(undefined)).toBe("");
    }).pipe(
      Effect.provide(DrivePacks.layerBucket(previewBucket, DrivePacks.drivePackPrefix("pr-212/"))),
    );
  });

  it("rejects prefixes outside the PR namespace", () => {
    expect(() => DrivePacks.drivePackPrefix("drive-1/")).toThrow(
      "DRIVE_PACKS_PREFIX must be empty or a PR prefix such as pr-123/.",
    );
  });
});
