// @effect-diagnostics nodeBuiltinImport:off - This standalone Node build adapter prepares and verifies local deployment files before Worker bundling.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { executableSyntheticVariant } from "./executableVariant.fixture.ts";
import { loadHarnessRelease } from "../../../src/harness/HarnessReleaseLoader.ts";
import { fixture } from "../../harnessReleases/fixtures/claudeReleaseVariants.ts";
import {
  directoryHarnessArtifactStore,
  publishHarnessArtifact,
} from "../../harnessReleases/publishArtifact.ts";
import { writeReleaseDeploymentAssets } from "../../harnessReleases/deploymentAssets.ts";
import type { HarnessReleaseDeployment } from "../../../src/harnessReleases/HarnessReleaseDeployment.ts";

export const fixtureHash = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Small candidate graphs with no approval proofs. These cannot qualify an official release. */
export async function syntheticAssets() {
  const f = await fixture(false);
  f.close();
  const baseline = executableSyntheticVariant(f.baseline);
  const hooks = executableSyntheticVariant(f.hooks);
  const source = {
    read: async (ref: string, path: string) => {
      const variant = [baseline, hooks].find(
        (candidate) => candidate.fullArtifact.artifactRef === ref,
      );
      const bytes = variant?.files.get(path);
      if (!bytes) throw new Error("Unknown synthetic artifact file");
      return bytes.slice();
    },
  };
  const identity = {
    artifactRef: baseline.fullArtifact.artifactRef,
    artifactHash: baseline.fullArtifact.artifactHash,
    sourceIdentity: baseline.fullArtifact.sourceIdentity,
  };
  const loaded = await loadHarnessRelease({
    identity,
    source,
    trustedComputer: f.input.trustedComputer,
    maxPreparedModuleBytes: f.input.maxPreparedModuleBytes,
  });
  const baselinePin = { identity, preparedModules: loaded.plan.preparedModules };
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "signalbox-deploy3-synthetic-"),
  );
  try {
    const assetsDirectory = NodePath.join(root, "assets");
    await NodeFSP.mkdir(NodePath.join(assetsDirectory, "web"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(assetsDirectory, "web/index.html"),
      "Synthetic deploy3 assets",
    );
    const store = directoryHarnessArtifactStore(assetsDirectory);
    const projectId = "synthetic deploy3/project%name";
    const indexes = [];
    for (const [name, variant] of [
      ["baseline", baseline],
      ["hooks", hooks],
    ] as const) {
      const directory = NodePath.join(root, name);
      for (const [path, bytes] of variant.files) {
        const file = NodePath.join(directory, path);
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, bytes);
      }
      indexes.push(
        (await publishHarnessArtifact(variant.fullArtifact, directory, { projectId, store }))
          .assetIndex,
      );
    }
    const deployment: HarnessReleaseDeployment = {
      schemaVersion: 1,
      purpose: "qualification",
      projectId,
      ledger: [baseline, hooks].map(({ fullArtifact }) => ({
        artifact: fullArtifact,
        proofs: [],
      })),
      assets: indexes,
      claudeVariants: {
        baseline: { variant: "baseline", fullArtifact: baseline.fullArtifact },
        hooks: { variant: "hooks", fullArtifact: hooks.fullArtifact },
      },
    };
    const written = await writeReleaseDeploymentAssets({ directory: assetsDirectory, deployment });
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
    return {
      root,
      assetsDirectory,
      binding,
      deployment,
      input: {
        schema: "sb1070/deploy3-claude-assets/v2" as const,
        ownerIssue: 1072 as const,
        assets: {
          status: "supplied" as const,
          purpose: "qualification" as const,
          projectId,
          metadata: written.pin,
          baselinePin,
          trustedComputer: f.input.trustedComputer,
          maxPreparedModuleBytes: f.input.maxPreparedModuleBytes,
        },
      },
      dispose: () => NodeFSP.rm(root, { recursive: true, force: true }),
    };
  } catch (cause) {
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw cause;
  }
}
