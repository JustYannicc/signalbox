import type { ClaudeMcpProbe } from "./claudeMcpProbe.ts";
import type { AssetFetcher } from "../../../../src/assets/ChunkedAsset.ts";
import type { HarnessProcessResumePreparedRelease } from "../../../../src/harness/HarnessProcessResume.ts";
import type { HarnessCProductProgramService } from "../../../../src/harness/HarnessCProductCapabilities.ts";
import type { MachineProgramInventory } from "../../../../src/computer/MachineProgramInventory.ts";
import type { HarnessFilesCheckpoint } from "../../../../src/harness/HarnessFilesStore.ts";
import { assert, sha256 } from "./common.ts";
import type { RpcSerializable } from "./rpcSerializable.ts";
import type { Deploy3ClaudeAssets } from "../claudeAssets.schema.ts";

export interface AssetPin {
  path: string;
  bytes: number;
  sha256: string;
}
export interface ChunkedAsset extends AssetPin {
  chunks: readonly (AssetPin & { offset: number })[];
}
export interface Configuration {
  schema: "sb1070/qualifier-input/v1";
  runId: string;
  workerName: string;
  mainCommit: string;
  mainTree: string;
  expectedRelease: HarnessProcessResumePreparedRelease;
  releaseFiles: Readonly<Record<string, ChunkedAsset>>;
  releaseLoaderConfig: {
    trustedComputer: { sourceIdentity: string; manifestSha256: string };
    maxPreparedModuleBytes: number;
  };
  programCatalog: RpcSerializable<Awaited<ReturnType<HarnessCProductProgramService["catalog"]>>>;
  programPaths: Readonly<Record<string, AssetPin>>;
  machineInventory: MachineProgramInventory;
  seed: Omit<HarnessFilesCheckpoint, "files"> & {
    files: readonly { path: string; mode: number; kind?: "symlink"; contentBase64: string }[];
  };
  turnJson: readonly string[];
  facetSource: string;
  commandRegistryHashes: readonly string[];
  observer: { routePinsSha256: string; producerListSha256: string };
  sourcePins: Readonly<Record<string, string>>;
  claude: {
    runtime: {
      schema: "sb1070/deploy3-claude-facet/v1";
      purpose: "qualification";
      assets: typeof Deploy3ClaudeAssets.Type;
      workload: {
        collectorNonce: string;
        apiRevision: "EC1APIr2";
        model: string;
        mcpProbe: ClaudeMcpProbe;
      };
      turnJson: Readonly<Record<"baseline" | "hooks", readonly string[]>>;
      seed: { home: string; cwd: string };
    };
    facetSource: string;
    environmentPackages: Readonly<Record<string, AssetPin>>;
    expected: Readonly<Record<"baseline" | "hooks", HarnessProcessResumePreparedRelease>>;
  };
}
export async function readAsset(binding: AssetFetcher, pin: AssetPin) {
  const response = await binding.fetch(new Request(`https://assets.invalid/${pin.path}`));
  assert(response.ok, `Missing pinned asset ${pin.path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(
    bytes.length === pin.bytes && (await sha256(bytes)) === pin.sha256,
    `Changed asset ${pin.path}`,
  );
  return bytes;
}
export async function readConfiguration(binding: AssetFetcher, configHash: string) {
  const response = await binding.fetch(new Request("https://assets.invalid/qualifier/config.json"));
  assert(response.ok, "The frozen qualifier configuration is missing");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert((await sha256(bytes)) === configHash, "The qualifier configuration hash changed");
  const config = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Configuration;
  assert(
    config.schema === "sb1070/qualifier-input/v1" &&
      config.mainCommit.length === 40 &&
      config.runId.length === 36,
    "Qualifier configuration shape changed",
  );
  return config;
}
