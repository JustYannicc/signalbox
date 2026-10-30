import { describe, expect, it } from "vite-plus/test";
import { assetSha256, writeChunkedAsset } from "../../assets/ChunkedAsset.ts";
import {
  materializeHarnessProcessModules,
  preparedReleaseAsset,
} from "../../harness/HarnessProcessPlacement.ts";
import { serializeHarnessReleaseArtifactManifest } from "../HarnessReleaseArtifact.ts";
import {
  createHarnessArtifactAssetSource,
  harnessArtifactKey,
} from "../HarnessReleaseAssetSource.ts";

const reference = `sha256:${"a".repeat(64)}`;

async function fixture() {
  const bytes = new TextEncoder().encode("export const official = true;");
  const sourceIdentity = "b".repeat(64);
  const payloads = new Map<string, Uint8Array>([
    ["codex/main.js", bytes],
    ["codex/manifest.json", new TextEncoder().encode("{}")],
  ]);
  const pins = Object.fromEntries(
    await Promise.all(
      [...payloads].map(
        async ([path, bytes]) =>
          [path, { bytes: bytes.length, sha256: await assetSha256(bytes) }] as const,
      ),
    ),
  );
  const manifest = serializeHarnessReleaseArtifactManifest({
    schemaVersion: 1,
    harness: "codex",
    sourceIdentity,
    computer: { sourceIdentity: "c".repeat(64), manifestSha256: "d".repeat(64) },
    components: { codex: { manifest: "codex/manifest.json" } },
    files: pins,
  });
  const reference = `sha256:${await assetSha256(manifest)}`;
  payloads.set("manifest.json", manifest);
  const files = new Map<string, Uint8Array>();
  const entries = await Promise.all(
    [...payloads].map(
      async ([path, bytes]) =>
        [
          path,
          await writeChunkedAsset(
            bytes,
            harnessArtifactKey("alpha", reference, path),
            async (path, bytes) => {
              files.set(path, Uint8Array.from(bytes));
            },
          ),
        ] as const,
    ),
  );
  const index = {
    schemaVersion: 1,
    projectId: "alpha",
    artifactRef: reference,
    sourceIdentity,
    files: Object.fromEntries(entries),
  };
  const binding = {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const bytes = files.get(path);
      return bytes
        ? new Response(Uint8Array.from(bytes).buffer)
        : new Response(null, { status: 404 });
    },
  };
  return { bytes, index, binding, files, reference };
}

describe("deployed release asset source", () => {
  it("keeps the selected project, reference and file inventory separate", async () => {
    const f = await fixture();
    const source = createHarnessArtifactAssetSource(f.binding, "alpha", f.index);
    expect(await source.read(f.reference, "codex/main.js")).toEqual(f.bytes);
    expect(() => createHarnessArtifactAssetSource(f.binding, "beta", f.index)).toThrow(
      "HARNESS_ARTIFACT_PROJECT_MISMATCH",
    );
    await expect(source.read(`sha256:${"b".repeat(64)}`, "codex/main.js")).rejects.toThrow(
      "HARNESS_ARTIFACT_REFERENCE_MISMATCH",
    );
    await expect(source.read(f.reference, "codex/missing.js")).rejects.toThrow(
      "HARNESS_ARTIFACT_FILE_MISSING",
    );
  });

  it("uses the shared product materializer to reject wrong whole-file pins before returning module code", async () => {
    const f = await fixture();
    const source = createHarnessArtifactAssetSource(f.binding, "alpha", f.index);
    const release = {
      artifact: { artifactRef: f.reference },
      plan: {
        preparedModules: {
          "codex/main.js": {
            path: "codex/main.js",
            bytes: f.bytes.length,
            sha256: await assetSha256(f.bytes),
            type: "js" as const,
          },
        },
      },
    };
    const modules = { "main.js": preparedReleaseAsset(release, "codex/main.js") };
    const read = (ref: string, path: string, offset: number, length: number) =>
      source.readRange!(ref, path, offset, length);
    expect(await materializeHarnessProcessModules(modules, release, read)).toEqual({
      "main.js": { js: new TextDecoder().decode(f.bytes) },
    });
    const alteredIndex = {
      ...f.index,
      files: {
        ...f.index.files,
        "codex/main.js": {
          ...f.index.files["codex/main.js"]!,
          sha256: "f".repeat(64),
        },
      },
    };
    const altered = createHarnessArtifactAssetSource(f.binding, "alpha", alteredIndex);
    await expect(
      altered.readRange!(f.reference, "codex/main.js", 0, f.bytes.length),
    ).rejects.toThrow("HARNESS_ARTIFACT_ASSET_INDEX_MISMATCH");
    const wrong = {
      ...release,
      plan: {
        preparedModules: {
          "codex/main.js": {
            ...release.plan.preparedModules["codex/main.js"],
            sha256: "f".repeat(64),
          },
        },
      },
    };
    await expect(
      materializeHarnessProcessModules(
        { "main.js": preparedReleaseAsset(wrong, "codex/main.js") },
        wrong,
        read,
      ),
    ).rejects.toThrow("SHA-256");
    f.files.clear();
    await expect(materializeHarnessProcessModules(modules, release, read)).rejects.toThrow(
      "CHUNKED_ASSET_HTTP_404",
    );
  });

  it("rejects escaping paths and malformed references", () => {
    for (const path of ["/main", "../main", "cli/../main", "cli//main", "cli\\main", "cli/main?x"])
      expect(() => harnessArtifactKey("alpha", reference, path)).toThrow(
        "HARNESS_ARTIFACT_PATH_INVALID",
      );
    expect(() =>
      harnessArtifactKey("alpha", "https://artifact.test/main", "manifest.json"),
    ).toThrow("HARNESS_ARTIFACT_REFERENCE_INVALID");
    expect(harnessArtifactKey("alpha/beta", reference, "manifest.json")).not.toBe(
      harnessArtifactKey("alpha", reference, "beta/manifest.json"),
    );
  });
});
