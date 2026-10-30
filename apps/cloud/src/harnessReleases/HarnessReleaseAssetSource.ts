import * as Schema from "effect/Schema";
import {
  ChunkedAsset,
  assertAssetPath,
  decodeChunkedAsset,
  readChunkedAsset,
  readChunkedAssetRange,
  type AssetFetcher,
} from "../assets/ChunkedAsset.ts";
import {
  openHarnessReleaseArtifact,
  type HarnessReleaseArtifactSource,
} from "./HarnessReleaseArtifact.ts";

export const HarnessReleaseAssetIndex = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectId: Schema.String,
  artifactRef: Schema.String,
  sourceIdentity: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  files: Schema.Record(Schema.String, ChunkedAsset),
});
export type HarnessReleaseAssetIndex = typeof HarnessReleaseAssetIndex.Type;
const decodeIndex = Schema.decodeUnknownSync(HarnessReleaseAssetIndex, {
  onExcessProperty: "error",
  reportInput: false,
});

const artifactHash = (reference: string) => {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(reference);
  if (match === null) throw new Error("HARNESS_ARTIFACT_REFERENCE_INVALID");
  return match[1]!;
};

const filePath = (path: string) => {
  try {
    return assertAssetPath(path);
  } catch {
    throw new Error("HARNESS_ARTIFACT_PATH_INVALID");
  }
};

export const harnessArtifactKey = (
  projectId: string,
  reference: string,
  path: string,
  prefix = "",
) => {
  if (projectId.trim() === "" || projectId.length > 512)
    throw new Error("HARNESS_ARTIFACT_PROJECT_INVALID");
  if (prefix !== "" && !/^pr-[1-9]\d*\/$/u.test(prefix))
    throw new Error("HARNESS_ARTIFACT_PREFIX_INVALID");
  return filePath(
    `${prefix}harness-releases/${encodeURIComponent(projectId)}/${artifactHash(reference)}/${filePath(path)}`,
  );
};

/** The index is embedded in the deployment; the caller supplies its authorized project. */
export const createHarnessArtifactAssetSource = (
  binding: AssetFetcher,
  projectId: string,
  input: unknown,
): HarnessReleaseArtifactSource => {
  const index = decodeIndex(structuredClone(input));
  if (index.projectId !== projectId) throw new Error("HARNESS_ARTIFACT_PROJECT_MISMATCH");
  harnessArtifactKey(projectId, index.artifactRef, "manifest.json");
  for (const [path, file] of Object.entries(index.files)) {
    filePath(path);
    decodeChunkedAsset(file);
  }
  if (
    !Object.hasOwn(index.files, "manifest.json") ||
    index.files["manifest.json"]!.sha256 !== artifactHash(index.artifactRef)
  )
    throw new Error("HARNESS_ARTIFACT_MANIFEST_ASSET_MISMATCH");
  const selected = (reference: string, path: string) => {
    if (reference !== index.artifactRef) throw new Error("HARNESS_ARTIFACT_REFERENCE_MISMATCH");
    filePath(path);
    if (!Object.hasOwn(index.files, path)) throw new Error("HARNESS_ARTIFACT_FILE_MISSING");
    return index.files[path]!;
  };
  const raw: HarnessReleaseArtifactSource = {
    read: async (reference, path) => readChunkedAsset(binding, selected(reference, path)),
  };
  let verified: Promise<void> | undefined;
  const verifyIndex = () =>
    (verified ??= (async () => {
      const hash = artifactHash(index.artifactRef);
      const artifact = await openHarnessReleaseArtifact(
        {
          artifactRef: index.artifactRef,
          artifactHash: hash,
          sourceIdentity: index.sourceIdentity,
        },
        raw,
      );
      const expected = {
        ...artifact.manifest.files,
        "manifest.json": { bytes: index.files["manifest.json"]!.bytes, sha256: hash },
      };
      if (Object.keys(index.files).length !== Object.keys(expected).length)
        throw new Error("HARNESS_ARTIFACT_ASSET_INDEX_MISMATCH");
      for (const [path, pin] of Object.entries(expected)) {
        const file = selected(index.artifactRef, path);
        if (file.bytes !== pin.bytes || file.sha256 !== pin.sha256)
          throw new Error("HARNESS_ARTIFACT_ASSET_INDEX_MISMATCH");
      }
    })());
  return {
    read: async (reference, path) => {
      selected(reference, path);
      await verifyIndex();
      return raw.read(reference, path);
    },
    readRange: async (reference, path, offset, length) => {
      const file = selected(reference, path);
      await verifyIndex();
      return readChunkedAssetRange(binding, file, offset, length);
    },
  };
};
