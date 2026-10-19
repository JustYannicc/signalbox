import {
  openHarnessReleaseArtifact,
  type HarnessReleaseArtifactIdentity,
  type HarnessReleaseArtifactSource,
} from "../harnessReleases/HarnessReleaseArtifact.ts";
import {
  planHarnessRelease,
  type HarnessReleasePlan,
  type HarnessReleasePlanInput,
} from "./HarnessReleasePlan.ts";
import { validateModuleMaps } from "./releaseLoader/moduleMaps.ts";

export interface LoadHarnessReleaseOptions extends Pick<
  HarnessReleasePlanInput,
  "trustedComputer" | "maxPreparedModuleBytes"
> {
  readonly identity: HarnessReleaseArtifactIdentity;
  readonly source: HarnessReleaseArtifactSource;
}

export interface LoadedHarnessRelease {
  readonly plan: HarnessReleasePlan;
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/** Resolves only after every required payload is verified, so callers can then import modules. */
export async function loadHarnessRelease(
  options: LoadHarnessReleaseOptions,
): Promise<LoadedHarnessRelease> {
  const identity = { ...options.identity };
  const trustedComputer = { ...options.trustedComputer };
  const { source, maxPreparedModuleBytes } = options;
  const artifact = await openHarnessReleaseArtifact(identity, source);
  const plan = planHarnessRelease({
    manifest: artifact.manifest,
    rawManifests: artifact.rawManifests,
    artifactHash: identity.artifactHash,
    trustedComputer,
    maxPreparedModuleBytes,
  });
  const required = [
    ...Object.values(plan.preparedModules),
    ...plan.assets,
    ...(plan.harness === "claude-code" ? plan.moduleMaps : []),
  ];
  const payloads = new Map<string, Uint8Array>();
  for (const { path } of required) {
    if (!payloads.has(path)) payloads.set(path, await artifact.read(path));
  }
  if (plan.harness === "claude-code") validateModuleMaps(plan, payloads);
  return { plan, payloads };
}
