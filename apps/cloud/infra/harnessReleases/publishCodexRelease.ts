import type { HarnessReleaseArtifactIdentity } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { snapshotDeploymentLedger } from "../../src/harnessReleases/HarnessReleaseDeployment.ts";
import { readBuildLedger } from "./readBuildLedger.ts";
import { directoryHarnessArtifactStore, publishHarnessArtifact } from "./publishArtifact.ts";
import { writeReleaseDeploymentAssets } from "./deploymentAssets.ts";

export function publishCodexRelease(input: {
  readonly ledger: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly identity: HarnessReleaseArtifactIdentity;
  readonly directory: string;
  readonly assetsDirectory: string;
}) {
  return readBuildLedger(input.ledger, input.projectId, async (ledger) => {
    const artifact = ledger.getArtifact("codex", input.releaseId);
    if (
      !artifact ||
      artifact.artifactRef !== input.identity.artifactRef ||
      artifact.artifactHash !== input.identity.artifactHash ||
      artifact.sourceIdentity !== input.identity.sourceIdentity
    )
      throw new Error("HARNESS_DEPLOYMENT_LEDGER_MISMATCH");
    snapshotDeploymentLedger(ledger, [artifact]);
    const published = await publishHarnessArtifact(artifact, input.directory, {
      projectId: input.projectId,
      store: directoryHarnessArtifactStore(input.assetsDirectory),
    });
    const deployment = await writeReleaseDeploymentAssets({
      directory: input.assetsDirectory,
      deployment: {
        schemaVersion: 1,
        purpose: "release",
        projectId: input.projectId,
        ledger: snapshotDeploymentLedger(ledger, [artifact]),
        assets: [published.assetIndex],
      },
    });
    return { ...published, deployment };
  });
}
