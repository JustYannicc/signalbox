import { serializeHarnessReleaseArtifactManifest } from "../../../harnessReleases/HarnessReleaseArtifact.ts";
import { loadHarnessRelease } from "../../HarnessReleaseLoader.ts";
import type { HarnessProcessResumePreparedRelease } from "../../HarnessProcessResume.ts";

export async function reference(id: string, bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return {
    id,
    bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export interface ReleaseMaterial {
  readonly artifact: HarnessProcessResumePreparedRelease["artifact"];
  readonly trustedComputer: { readonly sourceIdentity: string; readonly manifestSha256: string };
  readonly files: Readonly<Record<string, Uint8Array>>;
}

/** A test artifact describes the exact plain-process bundle, with no provider qualification claim. */
export async function releaseMaterial(source: string, variant: string): Promise<ReleaseMaterial> {
  const sourceIdentity = (await reference("source", new TextEncoder().encode(source))).sha256;
  const module = new TextEncoder().encode(source);
  const sdk = new TextEncoder().encode("export function initialize() { return 'plain-fixture'; }");
  const main = await reference("main", module);
  const sdkRef = await reference("sdk", sdk);
  const trustedComputer = {
    sourceIdentity,
    manifestSha256: (
      await reference(
        "plain-runtime-inventory",
        jsonBytes({
          runtime: { path: "plain.mjs", bytes: main.bytes, sha256: main.sha256 },
          sdk: { path: "sdk.mjs", bytes: sdkRef.bytes, sha256: sdkRef.sha256 },
        }),
      )
    ).sha256,
  };
  const map = jsonBytes({ "plain.mjs": { path: "plain.mjs", type: "js" } });
  const mapRef = await reference("map", map);
  const files = new Map<string, Uint8Array>([
    ["cli/plain.mjs", module],
    ["cli/module-map.json", map],
    ["sdk/sdk.mjs", sdk],
  ]);
  files.set(
    "cli/manifest.json",
    jsonBytes({
      schemaVersion: 1,
      release: {
        provider: "claude-code",
        version: `plain-fixture-${variant}`,
        platform: "linux-x64",
        binarySha256: sourceIdentity,
      },
      mainModule: "plain.mjs",
      mainExport: "launch",
      embeddedEntrypointExport: "launch",
      embeddedEntrypoints: {},
      hostEntrypoints: {},
      moduleMap: { path: "module-map.json", sha256: mapRef.sha256 },
      modules: {
        "plain.mjs": { path: "plain.mjs", type: "js", bytes: main.bytes, sha256: main.sha256 },
      },
      assets: {},
      requiredHostModules: [],
      environmentPackageModules: {},
      bytes: main.bytes,
    }),
  );
  files.set(
    "sdk/manifest.json",
    jsonBytes({
      schemaVersion: 1,
      release: {
        provider: "agent-sdk",
        name: "@anthropic-ai/claude-agent-sdk",
        version: "plain-fixture",
        integrity: "plain-fixture",
        tarballSha256: sdkRef.sha256,
      },
      mainModule: "sdk.mjs",
      initializeExport: "initialize",
      modules: {
        "sdk.mjs": { path: "sdk.mjs", type: "js", bytes: sdkRef.bytes, sha256: sdkRef.sha256 },
      },
      requiredHostModules: [],
    }),
  );
  const inventory: Record<string, { bytes: number; sha256: string }> = {};
  for (const [path, bytes] of files) {
    const ref = await reference(path, bytes);
    inventory[path] = { bytes: ref.bytes, sha256: ref.sha256 };
  }
  const manifest = serializeHarnessReleaseArtifactManifest({
    schemaVersion: 1,
    harness: "claude-code",
    sourceIdentity,
    computer: trustedComputer,
    components: { cli: { manifest: "cli/manifest.json" }, sdk: { manifest: "sdk/manifest.json" } },
    files: inventory,
  });
  files.set("manifest.json", manifest);
  const hash = (await reference("manifest", manifest)).sha256;
  return {
    artifact: {
      provider: "claude-code",
      releaseId: `plain-${variant}-${hash.slice(0, 12)}`,
      artifactHash: hash,
      artifactRef: `sha256:${hash}`,
      sourceIdentity,
      fixtureIdentity: `plain-process-${variant}`,
      createdAt: "2026-10-25T09:00:00.000Z",
    },
    trustedComputer,
    files: Object.fromEntries(files),
  };
}

export async function loadMaterial(
  material: ReleaseMaterial,
): Promise<HarnessProcessResumePreparedRelease> {
  const files = new Map(Object.entries(material.files));
  const loaded = await loadHarnessRelease({
    identity: {
      artifactRef: material.artifact.artifactRef,
      artifactHash: material.artifact.artifactHash,
      sourceIdentity: material.artifact.sourceIdentity,
    },
    trustedComputer: material.trustedComputer,
    maxPreparedModuleBytes: Object.values(material.files).reduce(
      (bytes, value) => bytes + value.byteLength,
      0,
    ),
    source: {
      async read(artifactRef, path) {
        if (artifactRef !== material.artifact.artifactRef)
          throw new Error("The fixture requested another artifact.");
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("The fixture artifact file is missing.");
        return bytes.slice();
      },
    },
  });
  return {
    artifact: material.artifact,
    plan: {
      release: loaded.plan.release,
      sourceIdentity: loaded.plan.sourceIdentity,
      computer: loaded.plan.computer,
      preparedModules: loaded.plan.preparedModules,
    },
  };
}
