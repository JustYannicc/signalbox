import { claudePlan } from "./releasePlan/claude.ts";
import { codexPlan } from "./releasePlan/codex.ts";
import type { HarnessReleasePlan, HarnessReleasePlanInput } from "./releasePlan/types.ts";
import { HarnessReleasePlanError } from "./releasePlan/validation.ts";

export { HarnessReleasePlanError };
export type {
  ClaudeReleasePlan,
  CodexReleasePlan,
  ComputerIdentity,
  HarnessReleasePlan,
  HarnessReleasePlanInput,
  PreparedModuleType,
  PreparedReleaseAsset,
  PreparedReleaseFile,
  PreparedReleaseModule,
  ReleaseComponent,
  ReleaseEntrypoint,
  ReleaseFile,
  VerifiedReleaseArtifact,
} from "./releasePlan/types.ts";

/**
 * Converts verified common metadata and untrusted provider wire manifests without I/O.
 * The caller must read every preparedModules entry through the accepted reader before
 * importing any module. A plan establishes neither runtime compatibility nor qualification.
 */
export function planHarnessRelease(input: HarnessReleasePlanInput): HarnessReleasePlan {
  if (!Number.isSafeInteger(input.maxPreparedModuleBytes) || input.maxPreparedModuleBytes < 0)
    throw new HarnessReleasePlanError("Invalid prepared module byte allowance");
  const { computer } = input.manifest;
  if (
    computer.sourceIdentity !== input.trustedComputer.sourceIdentity ||
    computer.manifestSha256 !== input.trustedComputer.manifestSha256
  )
    throw new HarnessReleasePlanError("Computer identity does not match the trusted pin");
  const expected = input.manifest.harness === "codex" ? ["codex"] : ["cli", "sdk"];
  for (const component of ["codex", "cli", "sdk"] as const) {
    if (
      (input.manifest.components[component] !== undefined) !== expected.includes(component) ||
      (input.rawManifests[component] !== undefined) !== expected.includes(component)
    )
      throw new HarnessReleasePlanError(`Unexpected provider component: ${component}`);
  }
  const plan = input.manifest.harness === "codex" ? codexPlan(input) : claudePlan(input);
  let remaining = input.maxPreparedModuleBytes;
  for (const module of Object.values(plan.preparedModules)) {
    // Subtraction keeps the admission decision exact even when the sum would overflow.
    if (module.bytes > remaining)
      throw new HarnessReleasePlanError("Prepared module bytes exceed the trusted allowance");
    remaining -= module.bytes;
  }
  return plan;
}
