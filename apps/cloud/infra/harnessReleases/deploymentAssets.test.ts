import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { WORKER_ASSET_MAX_BYTES } from "../../src/assets/ChunkedAsset.ts";
import { inventoryDeploymentAssets, writeReleaseDeploymentAssets } from "./deploymentAssets.ts";
import { directoryHarnessArtifactStore, publishHarnessArtifact } from "./publishArtifact.ts";
import {
  readHarnessReleaseDeployment,
  readHarnessReleaseQualificationInputs,
} from "../../src/harnessReleases/HarnessReleaseDeployment.ts";
import { loadHarnessRelease } from "../../src/harness/HarnessReleaseLoader.ts";
import { fixture } from "./fixtures/claudeReleaseVariants.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-assets-inventory-"));
  roots.push(path);
  return path;
}

it("counts existing Worker assets and reports the precise oversized file without splitting it", async () => {
  const directory = await root();
  await NodeFSP.mkdir(NodePath.join(directory, "web"));
  await NodeFSP.writeFile(NodePath.join(directory, "web/index.html"), "web");
  const oversized = NodePath.join(directory, "release.js");
  await NodeFSP.writeFile(oversized, "");
  await NodeFSP.truncate(oversized, WORKER_ASSET_MAX_BYTES + 7);
  await expect(inventoryDeploymentAssets(directory)).rejects.toThrow(
    '"path":"release.js","bytes":26214407,"excessBytes":7',
  );
  expect((await NodeFSP.stat(oversized)).size).toBe(WORKER_ASSET_MAX_BYTES + 7);
  await NodeFSP.truncate(oversized, 5);
  expect(await inventoryDeploymentAssets(directory)).toEqual({
    files: 2,
    bytes: 8,
    largestFileBytes: 5,
    maximumFileBytes: WORKER_ASSET_MAX_BYTES,
    maximumFiles: 20_000,
    plan: "free",
  });
});

it("loads a pending pair for qualification without publishing it to the release selector", async () => {
  const f = await fixture(false);
  const directory = await root();
  try {
    const assetsDirectory = NodePath.join(directory, "assets");
    const store = directoryHarnessArtifactStore(assetsDirectory);
    const indexes = [];
    for (const [name, variant] of [
      ["baseline", f.baseline],
      ["hooks", f.hooks],
    ] as const) {
      const source = NodePath.join(directory, name);
      for (const [path, bytes] of variant.files) {
        const target = NodePath.join(source, path);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, bytes);
      }
      const published = await publishHarnessArtifact(variant.fullArtifact, source, {
        store,
        projectId: "signalbox",
      });
      indexes.push(published.assetIndex);
    }
    const result = await writeReleaseDeploymentAssets({
      directory: assetsDirectory,
      deployment: {
        schemaVersion: 1,
        purpose: "qualification",
        projectId: "signalbox",
        claudeVariants: f.input.catalog,
        ledger: [f.baseline, f.hooks].map(({ fullArtifact }) => ({
          artifact: fullArtifact,
          proofs: [],
        })),
        assets: indexes,
      },
    });
    const binding = {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
          .slice(1)
          .split("/")
          .map(decodeURIComponent)
          .join("/");
        return new Response(
          Uint8Array.from(await NodeFSP.readFile(NodePath.join(assetsDirectory, path))).buffer,
        );
      },
    };
    const opened = await readHarnessReleaseQualificationInputs(binding, result.pin, "signalbox");
    for (const variant of ["baseline", "hooks"] as const) {
      const artifact = opened.claudeVariants![variant].fullArtifact;
      expect(opened.ledger.getEligibility("claude-code", artifact.releaseId).status).toBe(
        "pending",
      );
      expect(f.input.ledger.getEligibility("claude-code", artifact.releaseId).status).toBe(
        "pending",
      );
      const loaded = await loadHarnessRelease({
        identity: {
          artifactRef: artifact.artifactRef,
          artifactHash: artifact.artifactHash,
          sourceIdentity: artifact.sourceIdentity,
        },
        source: opened.source,
        trustedComputer: f.input.trustedComputer,
        maxPreparedModuleBytes: 4096,
      });
      expect(loaded.plan.harness).toBe("claude-code");
    }
    await expect(readHarnessReleaseDeployment(binding, result.pin, "signalbox")).rejects.toThrow(
      "HARNESS_DEPLOYMENT_PURPOSE_MISMATCH",
    );
  } finally {
    f.close();
  }
});
