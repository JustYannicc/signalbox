export interface HarnessArtifactBucket {
  readonly get: (key: string) => Promise<{
    readonly size: number;
    readonly arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const artifactHash = (reference: string) => {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(reference);
  if (match === null) throw new Error("HARNESS_ARTIFACT_REFERENCE_INVALID");
  return match[1]!;
};

const filePath = (path: string) => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /[\\?#]/u.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("HARNESS_ARTIFACT_PATH_INVALID");
  return path;
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
  return `${prefix}harness-releases/${encodeURIComponent(projectId)}/${artifactHash(reference)}/${filePath(path)}`;
};

/** The caller supplies the authorized project, never a project from the artifact payload. */
export const createHarnessArtifactBucketSource = (
  bucket: HarnessArtifactBucket,
  projectId: string,
  prefix = "",
) => ({
  read: async (reference: string, path: string) => {
    const object = await bucket.get(harnessArtifactKey(projectId, reference, path, prefix));
    if (object === null) throw new Error("HARNESS_ARTIFACT_OBJECT_MISSING");
    // Each official module must fit independently inside the deployed isolate's heap.
    if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_FILE_BYTES)
      throw new Error("HARNESS_ARTIFACT_OBJECT_TOO_LARGE");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== object.size) throw new Error("HARNESS_ARTIFACT_OBJECT_SIZE_CHANGED");
    return bytes;
  },
});
