import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  WORKER_ASSET_MAX_BYTES,
  WORKER_ASSET_MAX_FILES,
  assetSha256,
  readPinnedAsset,
} from "../../src/assets/ChunkedAsset.ts";
import {
  openHarnessReleaseDeployment,
  openHarnessReleaseQualificationInputs,
  type HarnessReleaseDeployment,
} from "../../src/harnessReleases/HarnessReleaseDeployment.ts";
import { directoryHarnessArtifactStore } from "./publishArtifact.ts";

/** Count the entire Worker asset directory, including its existing web and program assets. */
export async function inventoryDeploymentAssets(directory: string, plan: "free" | "paid" = "free") {
  const files: Array<{ path: string; bytes: number }> = [];
  const visit = async (relative: string): Promise<void> => {
    const entries = await NodeFSP.readdir(NodePath.join(directory, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        files.push({ path, bytes: (await NodeFSP.stat(NodePath.join(directory, path))).size });
      else throw new Error(`WORKER_ASSET_NOT_REGULAR_FILE: ${path}`);
    }
  };
  await visit("");
  const oversized = files.filter((file) => file.bytes > WORKER_ASSET_MAX_BYTES);
  if (oversized.length)
    throw new Error(
      `WORKER_ASSET_TOO_LARGE: ${JSON.stringify(oversized.map((file) => ({ ...file, excessBytes: file.bytes - WORKER_ASSET_MAX_BYTES })))}`,
    );
  if (files.length > WORKER_ASSET_MAX_FILES[plan])
    throw new Error(
      `WORKER_ASSET_COUNT_EXCEEDED: ${files.length} > ${WORKER_ASSET_MAX_FILES[plan]}`,
    );
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    largestFileBytes: files.reduce((largest, file) => Math.max(largest, file.bytes), 0),
    maximumFileBytes: WORKER_ASSET_MAX_BYTES,
    maximumFiles: WORKER_ASSET_MAX_FILES[plan],
    plan,
  };
}

export async function writeReleaseDeploymentAssets(input: {
  readonly directory: string;
  readonly deployment: HarnessReleaseDeployment;
  readonly plan?: "free" | "paid";
}) {
  const store = directoryHarnessArtifactStore(input.directory);
  const binding = {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      return new Response(Uint8Array.from(await store.read(path)).buffer);
    },
  };
  // Decode the ledger and every chunk inventory before making this deployment selectable.
  const open =
    input.deployment.purpose === "release"
      ? openHarnessReleaseDeployment
      : openHarnessReleaseQualificationInputs;
  open(input.deployment, binding, input.deployment.projectId);
  const bytes = new TextEncoder().encode(`${JSON.stringify(input.deployment)}\n`);
  if (bytes.byteLength > WORKER_ASSET_MAX_BYTES)
    throw new Error("HARNESS_DEPLOYMENT_INDEX_TOO_LARGE");
  const sha256 = await assetSha256(bytes);
  const path = `harness-releases/${encodeURIComponent(input.deployment.projectId)}/deployments/${sha256}.json`;
  await store.put(path, bytes);
  const pin = { path, bytes: bytes.byteLength, sha256 };
  await readPinnedAsset(binding, pin);
  const inventory = await inventoryDeploymentAssets(input.directory, input.plan);
  return { purpose: input.deployment.purpose, pin, inventory };
}
