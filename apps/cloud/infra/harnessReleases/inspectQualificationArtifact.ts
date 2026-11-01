import type { HarnessReleaseArtifactIdentity } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { openHarnessReleaseArtifact } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { artifactDirectorySource } from "./prepareArtifact.internal.ts";
import { verifyArtifactNodeBuiltins } from "./verifyNodeBuiltins.ts";

export async function inspectQualificationArtifact(input: {
  readonly directory: string;
  readonly identity: HarnessReleaseArtifactIdentity;
  readonly inventory?: string;
}) {
  const verify = async () => {
    const artifact = await openHarnessReleaseArtifact(
      input.identity,
      artifactDirectorySource(input.directory),
    );
    for (const path of Object.keys(artifact.manifest.files)) await artifact.read(path);
  };
  await verify();
  const openFindings = await verifyArtifactNodeBuiltins(
    input.directory,
    "qualification",
    input.inventory,
  );
  await verify();
  return { identity: input.identity, openFindings };
}
