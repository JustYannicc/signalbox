import {
  serializeHarnessReleaseArtifactManifest,
  type HarnessReleaseArtifactManifest,
  type HarnessReleaseArtifactSource,
} from "../../../harnessReleases/HarnessReleaseArtifact.ts";
import type { PreparedModuleType, ReleaseFile } from "../../HarnessReleasePlan.ts";

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
) {
  const inventory: Record<string, ReleaseFile> = {};
  for (const [path, bytes] of files) inventory[path] = await descriptor(bytes);
  const common = serializeHarnessReleaseArtifactManifest({
    schemaVersion: 1,
    ...composition,
    sourceIdentity,
    computer: trustedComputer,
    files: inventory,
  });
  files.set("manifest.json", common);
  const artifactHash = (await descriptor(common)).sha256;
  const identity = { artifactRef: `sha256:${artifactHash}`, artifactHash, sourceIdentity };
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

export async function codexFixture() {
  const files = new Map([
    ["codex/engine.wasm", new Uint8Array([0, 97, 115, 109])],
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

export const literalModuleName = "chunks/%2F%24bunfs%2Froot%2Fchunk.js";
const cliSpecifications: ReadonlyArray<{ name: string; path: string; type: PreparedModuleType }> = [
  { name: "cli.js", path: "main/cli.js", type: "js" },
  { name: "worker.cjs", path: "worker.cjs", type: "cjs" },
  { name: "data.txt", path: "data.txt", type: "text" },
  { name: "engine.wasm", path: "engine.wasm", type: "wasm" },
  { name: literalModuleName, path: literalModuleName, type: "js" },
];
export const cliModuleMap = () =>
  Object.fromEntries(cliSpecifications.map(({ name, path, type }) => [name, { path, type }]));

export async function claudeFixture(
  options: { cliMapBytes?: Uint8Array; sdkMapBytes?: Uint8Array } = {},
) {
  const files = new Map<string, Uint8Array>();
  const modules: Record<string, ReleaseFile & { path: string; type: PreparedModuleType }> = {};
  for (const { name, path, type } of cliSpecifications) {
    const bytes = encoder.encode(`synthetic ${name}`);
    files.set(`cli/${path}`, bytes);
    modules[name] = { path, type, ...(await descriptor(bytes)) };
  }
  const sdkBytes = encoder.encode("export const initialize = () => undefined;");
  files.set("sdk/sdk.mjs", sdkBytes);
  const sdkModule = { path: "sdk.mjs", type: "js", ...(await descriptor(sdkBytes)) };
  const assetBytes = encoder.encode("synthetic help asset");
  files.set("cli/assets/help", assetBytes);
  const asset = {
    path: "assets/help",
    ...(await descriptor(assetBytes)),
    key: "help",
    loader: 5,
    encoding: 0,
  };
  const cliMapBytes = options.cliMapBytes ?? encodeJson(cliModuleMap());
  files.set("cli/module-map.json", cliMapBytes);
  const cliModuleBytes = Object.values(modules).reduce((sum, module) => sum + module.bytes, 0);
  files.set(
    "cli/manifest.json",
    encodeJson({
      schemaVersion: 1,
      release: {
        provider: "claude-code",
        version: "synthetic-cli",
        platform: "linux-x64",
        binarySha256: "b".repeat(64),
      },
      mainModule: "cli.js",
      mainExport: "launch",
      embeddedEntrypointExport: "launch",
      embeddedEntrypoints: { "/embedded/worker": "worker.cjs" },
      hostEntrypoints: {},
      moduleMap: { path: "module-map.json", sha256: (await descriptor(cliMapBytes)).sha256 },
      modules,
      assets: {
        "/help": asset,
        "/second-help": { ...asset, key: "second-help" },
        "/module-asset": { ...asset, ...modules["data.txt"], key: "module-asset" },
      },
      requiredHostModules: [],
      environmentPackageModules: {},
      bytes: cliModuleBytes,
    }),
  );
  let sdkMap;
  if (options.sdkMapBytes !== undefined) {
    files.set("sdk/module-map.json", options.sdkMapBytes);
    sdkMap = { path: "module-map.json", sha256: (await descriptor(options.sdkMapBytes)).sha256 };
  }
  files.set(
    "sdk/manifest.json",
    encodeJson({
      schemaVersion: 1,
      release: {
        provider: "agent-sdk",
        name: "@anthropic-ai/claude-agent-sdk",
        version: "synthetic-sdk",
        integrity: "synthetic-integrity",
        tarballSha256: "e".repeat(64),
      },
      mainModule: "sdk.mjs",
      initializeExport: "initialize",
      modules: { "sdk.mjs": sdkModule },
      requiredHostModules: [],
      ...(sdkMap === undefined ? {} : { moduleMap: sdkMap }),
    }),
  );
  return artifactFixture(
    {
      harness: "claude-code",
      components: {
        cli: { manifest: "cli/manifest.json" },
        sdk: { manifest: "sdk/manifest.json" },
      },
    },
    files,
    cliModuleBytes + sdkBytes.byteLength,
  );
}
