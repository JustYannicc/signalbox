import type { HarnessProcessResumePreparedRelease } from "../../HarnessProcessResume.ts";
import type { HarnessReleaseArtifact } from "../../../harnessReleases/HarnessReleaseLedger.ts";
import { loadHarnessRelease } from "../../HarnessReleaseLoader.ts";
import { productLoadedPreparedRelease } from "../../ProductHarnessProcessRelease.ts";
import { codexFixture } from "../../releaseLoader/tests/artifactFixtures.ts";

/** Loads the fixture-owned Codex release independently of C's requested descriptor. */
export async function loadControlledCodexRelease(): Promise<HarnessProcessResumePreparedRelease> {
  const fixture = await codexFixture();
  const artifact: HarnessReleaseArtifact = {
    provider: "codex",
    releaseId: "workerd-cold-creation-controlled-codex",
    artifactHash: fixture.options.identity.artifactHash,
    artifactRef: fixture.options.identity.artifactRef,
    sourceIdentity: fixture.options.identity.sourceIdentity,
    fixtureIdentity: "workerd-cold-creation-controlled-codex",
    createdAt: "2026-10-27T00:00:00.000Z",
  };
  const loaded = await loadHarnessRelease(fixture.options);
  return productLoadedPreparedRelease("codex", artifact, loaded);
}
