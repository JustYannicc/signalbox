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
  /**
   * False leaves prepared module bytes to their materializer, which checks each one's digest
   * before any Worker receives it, so they are read once instead of twice.
   */
  readonly verifyPreparedModules?: boolean;
}

export interface LoadedHarnessRelease {
  readonly plan: HarnessReleasePlan;
  /** Holds verified assets and module maps only; prepared modules are verified but not retained. */
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/** A release its caller already loaded, with the options it was loaded and verified under. */
export interface VerifiedHarnessRelease {
  readonly options: Omit<LoadHarnessReleaseOptions, "source">;
  readonly loaded: LoadedHarnessRelease;
}

/**
 * The verified release when loading `options` would admit exactly it. Module admission does not
 * matter: a loaded release never holds module bytes, and materializing them verifies each one.
 */
export function reusableHarnessRelease(
  verified: VerifiedHarnessRelease | undefined,
  options: LoadHarnessReleaseOptions,
): LoadedHarnessRelease | undefined {
  if (verified === undefined) return undefined;
  const { identity, trustedComputer, maxPreparedModuleBytes } = verified.options;
  return identity.artifactRef === options.identity.artifactRef &&
    identity.artifactHash === options.identity.artifactHash &&
    identity.sourceIdentity === options.identity.sourceIdentity &&
    trustedComputer.sourceIdentity === options.trustedComputer.sourceIdentity &&
    trustedComputer.manifestSha256 === options.trustedComputer.manifestSha256 &&
    maxPreparedModuleBytes <= options.maxPreparedModuleBytes
    ? verified.loaded
    : undefined;
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
    ...(options.verifyPreparedModules === false ? [] : Object.values(plan.preparedModules)),
    ...plan.assets,
    ...(plan.harness === "claude-code" ? plan.moduleMaps : []),
  ];
  // Runtime loaders own imports; this admission check must verify their descriptors' bytes,
  // but no runtime consumer uses module buffers. Only assets and maps need to survive it.
  const retained = new Set([
    ...plan.assets.map(({ path }) => path),
    ...(plan.harness === "claude-code" ? plan.moduleMaps.map(({ path }) => path) : []),
  ]);
  const payloads = new Map<string, Uint8Array>();
  const verified = new Set<string>();
  for (const { path } of required) {
    if (verified.has(path)) continue;
    const bytes = await artifact.read(path);
    if (retained.has(path)) payloads.set(path, bytes);
    verified.add(path);
  }
  if (plan.harness === "claude-code") validateModuleMaps(plan, payloads);
  return { plan, payloads };
}
