import {
  copyBytes,
  decodeCanonicalManifestBytes,
  decodeHarnessReleaseArtifactIdentity,
  decodeRawProviderManifest,
  deepFreeze,
  failArtifact,
  harnessReleaseOmissionIdentityFromProviderManifest,
  HarnessReleaseArtifactError,
  HarnessReleaseArtifactManifestSchema,
  serializeHarnessReleaseArtifactManifest,
  sha256Hex,
  type DeepReadonly,
  type HarnessReleaseArtifactErrorCode,
  type HarnessReleaseArtifactManifest,
  type HarnessReleaseOmissionIdentity,
} from "./internal/artifactManifest.ts";

export const HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH = "manifest.json";

export {
  decodeRawProviderManifest,
  harnessReleaseOmissionIdentityFromProviderManifest,
  HarnessReleaseArtifactError,
  HarnessReleaseArtifactManifestSchema,
  serializeHarnessReleaseArtifactManifest,
};
export type {
  HarnessReleaseArtifactErrorCode,
  HarnessReleaseArtifactManifest,
  HarnessReleaseOmissionIdentity,
};

export interface HarnessReleaseArtifactIdentity {
  readonly artifactRef: string;
  readonly artifactHash: string;
  readonly sourceIdentity: string;
}

export interface HarnessReleaseArtifactSource {
  read(artifactRef: string, path: string): Promise<Uint8Array>;
}

export type HarnessReleaseArtifactRawManifests = DeepReadonly<{
  codex?: Record<string, unknown>;
  cli?: Record<string, unknown>;
  sdk?: Record<string, unknown>;
}>;

export interface OpenedHarnessReleaseArtifact {
  readonly manifest: DeepReadonly<HarnessReleaseArtifactManifest>;
  readonly rawManifests: HarnessReleaseArtifactRawManifests;
  readonly read: (path: string) => Promise<Uint8Array>;
}

const readVerifiedFile = async (
  source: HarnessReleaseArtifactSource,
  artifactRef: string,
  path: string,
  expected: { readonly bytes: number; readonly sha256: string },
  errors: {
    readonly size: HarnessReleaseArtifactErrorCode;
    readonly hash: HarnessReleaseArtifactErrorCode;
  },
) => {
  const bytes = copyBytes(await source.read(artifactRef, path));
  if (bytes.byteLength !== expected.bytes) failArtifact(errors.size);
  if ((await sha256Hex(bytes)) !== expected.sha256) failArtifact(errors.hash);
  return bytes;
};

export const openHarnessReleaseArtifact = async (
  identityInput: HarnessReleaseArtifactIdentity,
  source: HarnessReleaseArtifactSource,
): Promise<OpenedHarnessReleaseArtifact> => {
  const identity = decodeHarnessReleaseArtifactIdentity(identityInput);
  if (identity.artifactRef !== `sha256:${identity.artifactHash}`)
    failArtifact("ARTIFACT_REF_MISMATCH");

  const manifestBytes = copyBytes(
    await source.read(identity.artifactRef, HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH),
  );
  const manifest = await decodeCanonicalManifestBytes(manifestBytes, identity.artifactHash);
  if (manifest.sourceIdentity !== identity.sourceIdentity) failArtifact("SOURCE_IDENTITY_MISMATCH");

  const inventory = new Map(
    Object.entries(manifest.files).map(([path, file]) => [
      path,
      { bytes: file.bytes, sha256: file.sha256 },
    ]),
  );
  const rawManifests: {
    codex?: Record<string, unknown>;
    cli?: Record<string, unknown>;
    sdk?: Record<string, unknown>;
  } = {};
  const components = [manifest.components.codex, manifest.components.cli, manifest.components.sdk];
  for (const component of components) {
    if (!component) continue;
    const descriptor =
      inventory.get(component.manifest) ?? failArtifact("MISSING_COMPONENT_MANIFEST");
    const bytes = await readVerifiedFile(
      source,
      identity.artifactRef,
      component.manifest,
      descriptor,
      { size: "RAW_MANIFEST_SIZE_MISMATCH", hash: "RAW_MANIFEST_HASH_MISMATCH" },
    );
    const parsed = decodeRawProviderManifest(bytes);
    if (component.manifest.startsWith("codex/")) rawManifests.codex = parsed;
    else if (component.manifest.startsWith("cli/")) rawManifests.cli = parsed;
    else if (component.manifest.startsWith("sdk/")) rawManifests.sdk = parsed;
    else failArtifact("INVALID_COMPONENTS");
  }

  const providerOmission =
    rawManifests.cli === undefined
      ? undefined
      : harnessReleaseOmissionIdentityFromProviderManifest(rawManifests.cli);
  if (
    manifest.omission?.configuration.name !== providerOmission?.configuration.name ||
    (manifest.omission === undefined) !== (providerOmission === undefined)
  ) {
    failArtifact("OMISSION_IDENTITY_MISMATCH");
  }

  const verifiedReads = new Map<string, Promise<Uint8Array>>();
  const read = async (path: string): Promise<Uint8Array> => {
    const descriptor = inventory.get(path);
    if (!descriptor) return failArtifact("FILE_NOT_DECLARED");

    let verified = verifiedReads.get(path);
    const shared = verified !== undefined;
    if (!verified) {
      verified = readVerifiedFile(source, identity.artifactRef, path, descriptor, {
        size: "FILE_SIZE_MISMATCH",
        hash: "FILE_HASH_MISMATCH",
      });
      verifiedReads.set(path, verified);
    }

    try {
      const bytes = await verified;
      // The first caller owns the verified copy; overlapping callers need independent results.
      return shared ? Uint8Array.from(bytes) : bytes;
    } finally {
      if (verifiedReads.get(path) === verified) verifiedReads.delete(path);
    }
  };

  return {
    manifest: deepFreeze(manifest),
    rawManifests: deepFreeze(rawManifests),
    read,
  };
};
