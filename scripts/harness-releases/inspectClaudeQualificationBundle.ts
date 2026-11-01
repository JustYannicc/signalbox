import { inspectPublishedBuiltinCoverage } from "./nodeBuiltinGate.ts";
import { qualificationBuiltinFindings } from "./nodeBuiltinGate/findings.ts";
import { freezeArtifact } from "./releaseIdentity.ts";
import type { RuntimeBuiltinInventory } from "./runtimeBuiltinInventory.ts";

/** Keep inventory evidence bound to the bytes built in the preceding process. */
export async function inspectClaudeQualificationBundle(
  directory: string,
  artifactSha256: string,
  inventory: RuntimeBuiltinInventory,
) {
  if (inventory.capture?.inventoryRequestSha256 === undefined)
    throw new Error("NODE_BUILTIN_INVENTORY_REQUEST_REQUIRED");
  const before = await freezeArtifact(directory);
  if (before.sha256 !== artifactSha256) throw new Error("CLAUDE_BUILD_ARTIFACT_CHANGED");
  const builtinCoverage = await inspectPublishedBuiltinCoverage(directory, inventory);
  const after = await freezeArtifact(directory);
  if (after.sha256 !== artifactSha256) throw new Error("CLAUDE_BUILD_ARTIFACT_CHANGED");
  return {
    artifact: { sha256: artifactSha256, files: after.files },
    builtinCoverage,
    openFindings: qualificationBuiltinFindings(builtinCoverage),
    releasable: false,
  };
}
