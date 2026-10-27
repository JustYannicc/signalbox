import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { LoadHarnessReleaseOptions } from "../HarnessReleaseLoader.ts";
import type {
  HarnessCProductProvider,
  HarnessProcessResumePreparedRelease,
} from "../HarnessProcessResume.ts";

export interface HarnessCProductReleaseBindings {
  readonly getArtifact: (
    provider: HarnessCProductProvider,
    releaseId: string,
  ) => HarnessReleaseArtifact | null | Promise<HarnessReleaseArtifact | null>;
  readonly loadOptions: () => Promise<Omit<LoadHarnessReleaseOptions, "identity">>;
}

export interface HarnessCSelectedProductRelease {
  readonly artifact: HarnessReleaseArtifact;
  readonly release: LoadHarnessReleaseOptions;
}

export class HarnessCProductReleaseError extends Error {
  readonly _tag = "HarnessCProductReleaseError";
}

/** Selects the pinned artifact before the product host builds its loader inputs. */
export async function selectHarnessCProductRelease(input: {
  readonly provider: HarnessCProductProvider;
  readonly preparedReleaseId: string;
  readonly expected: HarnessProcessResumePreparedRelease;
  readonly bindings: HarnessCProductReleaseBindings;
}): Promise<HarnessCSelectedProductRelease> {
  if (input.provider !== "claude-code" && input.provider !== "codex")
    throw new HarnessCProductReleaseError("The requested product provider is unsupported.");

  if (
    input.preparedReleaseId.length === 0 ||
    input.expected.artifact.provider !== input.provider ||
    input.expected.artifact.releaseId !== input.preparedReleaseId
  )
    throw new HarnessCProductReleaseError(
      "The product bootstrap selection does not match its expected artifact.",
    );

  let artifact: HarnessReleaseArtifact | null;
  try {
    artifact = await input.bindings.getArtifact(input.provider, input.preparedReleaseId);
  } catch (cause) {
    throw new HarnessCProductReleaseError("The exact product release artifact could not be read.", {
      cause,
    });
  }
  if (artifact === null)
    throw new HarnessCProductReleaseError("The exact product release artifact is missing.");
  if (!sameArtifact(artifact, input.expected.artifact))
    throw new HarnessCProductReleaseError(
      "The exact product release artifact differs from the expected identity.",
    );
  let releaseOptions: Omit<LoadHarnessReleaseOptions, "identity">;
  try {
    releaseOptions = await input.bindings.loadOptions();
  } catch (cause) {
    throw new HarnessCProductReleaseError(
      "The product release loader configuration could not be read.",
      { cause },
    );
  }
  if (
    releaseOptions.trustedComputer.sourceIdentity !== input.expected.plan.computer.sourceIdentity ||
    releaseOptions.trustedComputer.manifestSha256 !== input.expected.plan.computer.manifestSha256
  )
    throw new HarnessCProductReleaseError(
      "The product release computer pin does not match the selected artifact.",
    );

  return {
    artifact,
    release: {
      ...releaseOptions,
      identity: {
        artifactRef: artifact.artifactRef,
        artifactHash: artifact.artifactHash,
        sourceIdentity: artifact.sourceIdentity,
      },
    },
  };
}

function sameArtifact(left: HarnessReleaseArtifact, right: HarnessReleaseArtifact): boolean {
  return sameData(left, right);
}

function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameData(value, right[index]))
    );
  const leftFields = Object.keys(left);
  const rightFields = Object.keys(right);
  return (
    leftFields.length === rightFields.length &&
    leftFields.every(
      (field) =>
        Object.hasOwn(right, field) &&
        sameData(
          (left as Record<string, unknown>)[field],
          (right as Record<string, unknown>)[field],
        ),
    )
  );
}
