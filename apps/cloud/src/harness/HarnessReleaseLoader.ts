import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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

/** Release files read at once; each is still verified on its own. */
export const RELEASE_READ_CONCURRENCY = 8;
/**
 * Release bytes read at once. A file this large or larger is read alone, so large modules never
 * sit in an isolate together, as when reads ran one at a time.
 */
export const RELEASE_READ_BYTES = 16 * 1024 * 1024;

/** One file's read failure; the load rethrows its `cause` unchanged. */
class ReleaseFileReadError extends Schema.TaggedError<ReleaseFileReadError>()(
  "ReleaseFileReadError",
  { cause: Schema.Unknown },
) {}
const isReleaseFileReadError = Schema.is(ReleaseFileReadError);

export interface LoadHarnessReleaseOptions extends Pick<
  HarnessReleasePlanInput,
  "trustedComputer" | "maxPreparedModuleBytes"
> {
  readonly identity: HarnessReleaseArtifactIdentity;
  readonly source: HarnessReleaseArtifactSource;
  /**
   * False skips reading prepared module bytes here, so they are read once, by their materializer,
   * which checks each digest before any Worker receives the module.
   */
  readonly verifyPreparedModules?: boolean;
}

/**
 * A plan with its verified assets and module maps. It never makes a module importable: module bytes
 * are verified only where `materializeHarnessProcessModules` (`materializePreparedReleaseAsset`)
 * reads them, so a caller must never import a `plan.preparedModules` path directly.
 */
export interface LoadedHarnessRelease {
  readonly plan: HarnessReleasePlan;
  /** Verified assets and module maps; prepared module bytes are never retained. */
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/** A release its caller already loaded, with the options it was loaded and verified under. */
export interface VerifiedHarnessRelease {
  readonly options: Omit<LoadHarnessReleaseOptions, "source">;
  readonly loaded: LoadedHarnessRelease;
}

/**
 * The verified release when loading `options` would admit exactly it. Both halves must match:
 * the options it was loaded under, and the loaded plan's own artifact, source and computer. Module
 * admission does not matter: a loaded release never holds module bytes.
 */
export function reusableHarnessRelease(
  verified: VerifiedHarnessRelease | undefined,
  options: LoadHarnessReleaseOptions,
): LoadedHarnessRelease | undefined {
  if (verified === undefined) return undefined;
  const { identity, trustedComputer, maxPreparedModuleBytes } = verified.options;
  const { plan } = verified.loaded;
  return identity.artifactRef === options.identity.artifactRef &&
    identity.artifactHash === options.identity.artifactHash &&
    identity.sourceIdentity === options.identity.sourceIdentity &&
    trustedComputer.sourceIdentity === options.trustedComputer.sourceIdentity &&
    trustedComputer.manifestSha256 === options.trustedComputer.manifestSha256 &&
    maxPreparedModuleBytes <= options.maxPreparedModuleBytes &&
    plan.release.manifestSha256 === options.identity.artifactHash &&
    plan.sourceIdentity === options.identity.sourceIdentity &&
    plan.computer.sourceIdentity === options.trustedComputer.sourceIdentity &&
    plan.computer.manifestSha256 === options.trustedComputer.manifestSha256
    ? verified.loaded
    : undefined;
}

/**
 * Resolves once the manifests, assets and module maps, and unless `verifyPreparedModules` is false
 * every prepared module's bytes, are verified. That never makes a module importable; see
 * `LoadedHarnessRelease`.
 */
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
  // Reading module bytes here only rejects a bad release early; imports rely on materialization's
  // own check. No runtime consumer uses module buffers, so only assets and maps survive it.
  const retained = new Set([
    ...plan.assets.map(({ path }) => path),
    ...(plan.harness === "claude-code" ? plan.moduleMaps.map(({ path }) => path) : []),
  ]);
  // A path both a module and an asset is read once. Reads overlap, so deployed latency is paid per
  // batch, not per file; the first failure interrupts and aborts the rest.
  const files = [...new Map(required.map((file) => [file.path, file])).values()];
  const inFlightBytes = Semaphore.makeUnsafe(RELEASE_READ_BYTES);
  const read = await Effect.runPromise(
    Effect.forEach(
      files,
      ({ path, bytes }) =>
        Effect.tryPromise({
          try: (signal) => artifact.read(path, signal),
          catch: (cause) => new ReleaseFileReadError({ cause }),
        }).pipe(
          Effect.map((payload) => (retained.has(path) ? payload : undefined)),
          inFlightBytes.withPermits(Math.max(1, Math.min(bytes, RELEASE_READ_BYTES))),
        ),
      { concurrency: RELEASE_READ_CONCURRENCY },
    ),
  ).catch((failure: unknown) => {
    throw isReleaseFileReadError(failure) ? failure.cause : failure;
  });
  const payloads = new Map<string, Uint8Array>();
  for (const [index, { path }] of files.entries()) {
    const payload = read[index];
    if (payload !== undefined) payloads.set(path, payload);
  }
  if (plan.harness === "claude-code") validateModuleMaps(plan, payloads);
  return { plan, payloads };
}
