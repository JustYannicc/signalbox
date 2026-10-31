import {
  serializeHarnessReleaseArtifactManifest,
  type HarnessReleaseArtifactManifest,
  type HarnessReleaseOmissionIdentity,
  type HarnessReleaseArtifactSource,
} from "../../../src/harnessReleases/HarnessReleaseArtifact.ts";
import type { ReleaseFile } from "../../../src/harness/HarnessReleasePlan.ts";

const encoder = new TextEncoder();
export const encodeJson = (value: unknown) => encoder.encode(JSON.stringify(value));
const trustedComputer = { sourceIdentity: "c".repeat(64), manifestSha256: "d".repeat(64) };
const sourceIdentity = "a".repeat(64);

async function descriptor(bytes: Uint8Array): Promise<ReleaseFile> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return {
    bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}

async function artifactFixture(
  composition: Pick<HarnessReleaseArtifactManifest, "harness" | "components">,
  files: Map<string, Uint8Array>,
  maxPreparedModuleBytes: number,
  omission?: HarnessReleaseOmissionIdentity,
  artifactSourceIdentity = sourceIdentity,
) {
  const inventory: Record<string, ReleaseFile> = {};
  for (const [path, bytes] of files) inventory[path] = await descriptor(bytes);
  const common = serializeHarnessReleaseArtifactManifest({
    schemaVersion: 1,
    ...composition,
    sourceIdentity: artifactSourceIdentity,
    computer: trustedComputer,
    files: inventory,
    ...(omission === undefined ? {} : { omission }),
  });
  files.set("manifest.json", common);
  const artifactHash = (await descriptor(common)).sha256;
  const identity = {
    artifactRef: `sha256:${artifactHash}`,
    artifactHash,
    sourceIdentity: artifactSourceIdentity,
  };
  const reads: string[] = [];
  const source: HarnessReleaseArtifactSource = {
    async read(artifactRef, path) {
      if (artifactRef !== identity.artifactRef) throw new Error("Wrong fixture artifact reference");
      reads.push(path);
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`Missing fixture file: ${path}`);
      return bytes;
    },
  };
  return {
    files,
    reads,
    options: { identity, source, trustedComputer: { ...trustedComputer }, maxPreparedModuleBytes },
  };
}

export async function codexFixture(options: { readonly engineBytes?: Uint8Array } = {}) {
  const files = new Map([
    ["codex/engine.wasm", options.engineBytes ?? new Uint8Array([0, 97, 115, 109])],
    ["codex/loader.mjs", encoder.encode("export const load = () => undefined;")],
    ["codex/helper.mjs", encoder.encode("export const helper = 1;")],
    ["codex/Cargo.lock", encoder.encode("synthetic build provenance")],
  ]);
  const inventory: Record<string, ReleaseFile> = {};
  for (const [path, bytes] of files)
    inventory[path.slice("codex/".length)] = await descriptor(bytes);
  const engine = inventory["engine.wasm"]!;
  files.set(
    "codex/manifest.json",
    encodeJson({
      abiVersion: 1,
      target: "wasm32-wasip1",
      version: "synthetic-codex",
      upstreamCommit: "synthetic-upstream",
      moduleBytes: engine.bytes,
      moduleSha256: engine.sha256,
      moduleBudgetBytes: engine.bytes,
      moduleBudgetPassed: true,
      files: inventory,
    }),
  );
  return artifactFixture(
    { harness: "codex", components: { codex: { manifest: "codex/manifest.json" } } },
    files,
    Object.entries(inventory).reduce(
      (sum, [name, file]) => sum + (name === "Cargo.lock" ? 0 : file.bytes),
      0,
    ),
  );
}
