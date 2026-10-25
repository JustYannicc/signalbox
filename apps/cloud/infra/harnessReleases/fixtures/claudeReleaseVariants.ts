import * as NodeCrypto from "node:crypto";
import { serializeHarnessReleaseArtifactManifest } from "../../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { createHarnessReleaseLedger } from "../../../src/harnessReleases/HarnessReleaseLedger.ts";
import { createHarnessReleaseSqliteStore } from "../../../src/harnessReleases/HarnessReleaseSqliteStore.ts";
import { createHarnessProjectReleaseSqliteStore } from "../../../src/harnessReleases/HarnessProjectReleaseSqliteStore.ts";
import { makeHarnessReleaseLedgerTestDatabase } from "../../../src/harnessReleases/testing.ts";
import { loadHarnessRelease } from "../../../src/harness/HarnessReleaseLoader.ts";

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const computer = { sourceIdentity: "c".repeat(64), manifestSha256: "d".repeat(64) };

async function artifact(
  variant: "baseline" | "hooks",
  change?: (cli: Record<string, unknown>, sdk: Record<string, unknown>) => void,
) {
  const files = new Map<string, Uint8Array>();
  const put = (path: string, bytes: Uint8Array) => {
    files.set(path, bytes);
    return { path: path.slice(path.indexOf("/") + 1), bytes: bytes.length, sha256: hash(bytes) };
  };
  const modules = {
    "signalbox/release.js": {
      ...put("cli/release.js", encode(`export function launch(){return '${variant}'}`)),
      type: "js",
    },
    ...(variant === "hooks"
      ? {
          "signalbox/worker-hooks.js": {
            ...put("cli/worker-hooks.js", encode("export function instantiate(){}")),
            type: "js",
          },
        }
      : {}),
  };
  const sdkModules = {
    "sdk.js": { ...put("sdk/sdk.js", encode("export function initialize(){}")), type: "js" },
  };
  const moduleMap = put(
    "cli/module-map.json",
    encode(
      Object.fromEntries(
        Object.entries(modules).map(([name, entry]) => [
          name,
          { path: entry.path, type: entry.type },
        ]),
      ),
    ),
  );
  const cli: Record<string, unknown> = {
    schemaVersion: 1,
    release: {
      provider: "claude-code",
      version: "2.1.303",
      platform: "linux-x64",
      binarySha256: "a".repeat(64),
    },
    mainModule: "signalbox/release.js",
    mainExport: "launch",
    embeddedEntrypointExport: "launch",
    environmentPackageModules: {},
    hostEntrypoints: {},
    requiredHostModules: [],
    embeddedEntrypoints: { "/official/hooks": "signalbox/release.js" },
    moduleMap,
    modules,
    assets: {},
    sourceModules: ["official/input.js"],
    omission: {
      schemaVersion: 1,
      configuration: { name: "product", env: {} },
      corpus: {
        binarySha256: "a".repeat(64),
        sha256: "e".repeat(64),
        provenance: [{ name: "original-capture", sha256: "f".repeat(64) }],
        pending: [],
      },
    },
    bytes: Object.values(modules).reduce((total, module) => total + module.bytes, 0),
    ...(variant === "hooks"
      ? {
          workerEntries: {
            "hooks-worker": {
              entry: "file:///official/hooks",
              module: "signalbox/worker-hooks.js",
              export: "instantiate",
              globals: [],
              imports: [],
              computedGlobalAccess: { count: 0, sites: [] },
              functionConstructors: { count: 0, sites: [] },
              sourceAnalysis: {
                computedGlobalAccess: { count: 0, sites: [] },
                functionConstructors: { count: 0, sites: [] },
              },
              inputs: ["official/input.js"],
              sourceBytes: 10,
              preparedBytes: modules["signalbox/worker-hooks.js"]!.bytes,
            },
          },
        }
      : {}),
  };
  const sdk: Record<string, unknown> = {
    schemaVersion: 1,
    release: {
      provider: "agent-sdk",
      name: "@anthropic-ai/claude-agent-sdk",
      version: "0.3.276",
      integrity: "sha512-same",
      tarballSha256: "b".repeat(64),
    },
    mainModule: "sdk.js",
    initializeExport: "initialize",
    modules: sdkModules,
    requiredHostModules: [],
  };
  change?.(cli, sdk);
  put("cli/manifest.json", encode(cli));
  put("sdk/manifest.json", encode(sdk));
  const sourceIdentity = (variant === "baseline" ? "1" : "2").repeat(64);
  const bytes = serializeHarnessReleaseArtifactManifest({
    schemaVersion: 1,
    harness: "claude-code",
    sourceIdentity,
    computer,
    components: { cli: { manifest: "cli/manifest.json" }, sdk: { manifest: "sdk/manifest.json" } },
    files: Object.fromEntries(
      [...files].map(([path, bytes]) => [path, { bytes: bytes.length, sha256: hash(bytes) }]),
    ),
    omission: { configuration: { name: "product" } },
  });
  files.set("manifest.json", bytes);
  const fullArtifact = {
    provider: "claude-code" as const,
    releaseId: variant,
    artifactRef: `sha256:${hash(bytes)}`,
    artifactHash: hash(bytes),
    sourceIdentity,
    fixtureIdentity: "same-real-fixture",
    createdAt: "2026-10-24T00:00:00Z",
  };
  return { fullArtifact, files };
}

export async function fixture(project: boolean, change?: Parameters<typeof artifact>[1]) {
  const database = makeHarnessReleaseLedgerTestDatabase();
  const ledger = createHarnessReleaseLedger(
    project
      ? createHarnessProjectReleaseSqliteStore(database.storage, "project")
      : createHarnessReleaseSqliteStore(database.storage),
  );
  const baseline = await artifact("baseline"),
    hooks = await artifact("hooks", change);
  ledger.registerArtifact(baseline.fullArtifact);
  ledger.registerArtifact(hooks.fullArtifact);
  const source = {
    read: async (ref: string, path: string) => {
      const bytes = (
        ref === baseline.fullArtifact.artifactRef
          ? baseline
          : ref === hooks.fullArtifact.artifactRef
            ? hooks
            : undefined
      )?.files.get(path);
      if (!bytes) throw new Error("missing fixture file");
      return Uint8Array.from(bytes);
    },
  };
  const loaded = await loadHarnessRelease({
    identity: {
      artifactRef: baseline.fullArtifact.artifactRef,
      artifactHash: baseline.fullArtifact.artifactHash,
      sourceIdentity: baseline.fullArtifact.sourceIdentity,
    },
    source,
    trustedComputer: computer,
    maxPreparedModuleBytes: 4096,
  });
  const input = {
    catalog: {
      baseline: { variant: "baseline", fullArtifact: baseline.fullArtifact },
      hooks: { variant: "hooks", fullArtifact: hooks.fullArtifact },
    },
    ledger,
    source,
    trustedComputer: computer,
    maxPreparedModuleBytes: 4096,
    baselinePin: {
      identity: {
        artifactRef: baseline.fullArtifact.artifactRef,
        artifactHash: baseline.fullArtifact.artifactHash,
        sourceIdentity: baseline.fullArtifact.sourceIdentity,
      },
      preparedModules: loaded.plan.preparedModules,
    },
  };
  return { input, baseline, hooks, close: () => database.database.close() };
}
