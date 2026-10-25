import { describe, expect, it } from "vite-plus/test";
import {
  createHarnessArtifactBucketSource,
  harnessArtifactKey,
} from "../HarnessReleaseArtifactBucket.ts";

const reference = `sha256:${"a".repeat(64)}`;

describe("Harness artifact bucket", () => {
  it("keeps project and preview reads separate without a production fallback", async () => {
    const objects = new Map([
      [harnessArtifactKey("alpha", reference, "cli/main.mjs"), "production"],
      [harnessArtifactKey("alpha", reference, "cli/main.mjs", "pr-72/"), "preview"],
      [harnessArtifactKey("beta", reference, "cli/main.mjs"), "other project"],
    ]);
    const bucket = {
      get: async (key: string) => {
        const text = objects.get(key);
        if (text === undefined) return null;
        const bytes = new TextEncoder().encode(text);
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
      },
    };
    const production = createHarnessArtifactBucketSource(bucket, "alpha");
    const preview = createHarnessArtifactBucketSource(bucket, "alpha", "pr-72/");
    expect(new TextDecoder().decode(await production.read(reference, "cli/main.mjs"))).toBe(
      "production",
    );
    expect(new TextDecoder().decode(await preview.read(reference, "cli/main.mjs"))).toBe("preview");
    objects.delete(harnessArtifactKey("alpha", reference, "cli/main.mjs", "pr-72/"));
    await expect(preview.read(reference, "cli/main.mjs")).rejects.toThrow(
      "HARNESS_ARTIFACT_OBJECT_MISSING",
    );
  });

  it("rejects paths and references that could escape the selected composition", () => {
    for (const path of [
      "/cli/main.mjs",
      "../main.mjs",
      "cli/../main",
      "cli//main",
      "cli\\main",
      "cli/main?x",
    ])
      expect(() => harnessArtifactKey("alpha", reference, path)).toThrow(
        "HARNESS_ARTIFACT_PATH_INVALID",
      );
    expect(() =>
      harnessArtifactKey("alpha", "https://artifact.test/main", "manifest.json"),
    ).toThrow("HARNESS_ARTIFACT_REFERENCE_INVALID");
    expect(() => harnessArtifactKey("alpha", reference, "manifest.json", "../")).toThrow(
      "HARNESS_ARTIFACT_PREFIX_INVALID",
    );
    expect(() => harnessArtifactKey(" ", reference, "manifest.json")).toThrow(
      "HARNESS_ARTIFACT_PROJECT_INVALID",
    );
    expect(harnessArtifactKey("alpha/beta", reference, "manifest.json")).not.toBe(
      harnessArtifactKey("alpha", reference, "beta/manifest.json"),
    );
    expect(harnessArtifactKey("alpha", reference, "cli/chunks/%2F%24bunfs%2Froot.js")).toContain(
      "/cli/chunks/%2F%24bunfs%2Froot.js",
    );
  });

  it("refuses oversized or changed objects before returning payload bytes", async () => {
    let bodyReads = 0;
    const body = async () => {
      bodyReads++;
      return new Uint8Array([1]).buffer;
    };
    const oversized = createHarnessArtifactBucketSource(
      { get: async () => ({ size: 64 * 1024 * 1024 + 1, arrayBuffer: body }) },
      "alpha",
    );
    await expect(oversized.read(reference, "codex/engine.wasm")).rejects.toThrow(
      "HARNESS_ARTIFACT_OBJECT_TOO_LARGE",
    );
    expect(bodyReads).toBe(0);
    const changed = createHarnessArtifactBucketSource(
      { get: async () => ({ size: 2, arrayBuffer: body }) },
      "alpha",
    );
    await expect(changed.read(reference, "codex/engine.wasm")).rejects.toThrow(
      "HARNESS_ARTIFACT_OBJECT_SIZE_CHANGED",
    );
  });
});
