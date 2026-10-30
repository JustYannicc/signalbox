import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  assertAssetPath,
  writeChunkedAsset,
  type ChunkedAsset,
} from "../../src/assets/ChunkedAsset.ts";
import {
  HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH,
  openHarnessReleaseArtifact,
  serializeHarnessReleaseArtifactManifest,
  type HarnessReleaseArtifactIdentity,
} from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import {
  createHarnessArtifactAssetSource,
  harnessArtifactKey,
} from "../../src/harnessReleases/HarnessReleaseAssetSource.ts";
import { matchesClaudeHostConfiguration } from "../../src/harness/ClaudeHostConfig.ts";
import { artifactDirectorySource } from "./prepareArtifact.ts";

export interface HarnessArtifactPublicationStore {
  readonly put: (key: string, bytes: Uint8Array) => Promise<void>;
  readonly read: (key: string) => Promise<Uint8Array>;
}

/** Publishes the manifest after every inventoried file has survived storage readback. */
export const publishHarnessArtifact = async (
  identity: HarnessReleaseArtifactIdentity,
  directory: string,
  destination: {
    readonly store: HarnessArtifactPublicationStore;
    readonly projectId: string;
    readonly prefix?: string;
  },
) => {
  const selected = {
    artifactRef: identity.artifactRef,
    artifactHash: identity.artifactHash,
    sourceIdentity: identity.sourceIdentity,
  };
  const { store, projectId, prefix } = destination;
  const local = artifactDirectorySource(directory);
  const artifact = await openHarnessReleaseArtifact(selected, local);
  if (
    ["cli", "sdk", "codex"].some((component) =>
      Object.hasOwn(artifact.manifest.files, `${component}/metafile.json`),
    )
  )
    throw new Error("HARNESS_ARTIFACT_CONTAINS_DIAGNOSTICS");
  if (artifact.manifest.omission) {
    if (artifact.manifest.omission.configuration.name !== "product")
      throw new Error("HARNESS_ARTIFACT_QUALIFICATION_ONLY");
    const providerOmission = artifact.rawManifests.cli?.omission;
    const providerConfiguration =
      providerOmission !== null && typeof providerOmission === "object"
        ? Reflect.get(providerOmission, "configuration")
        : undefined;
    if (!matchesClaudeHostConfiguration(providerConfiguration))
      throw new Error("HARNESS_ARTIFACT_PRODUCT_CONFIGURATION_MISMATCH");
  }
  const key = (path: string) => harnessArtifactKey(projectId, selected.artifactRef, path, prefix);
  const files: Record<string, ChunkedAsset> = {};
  const put = async (path: string, bytes: Uint8Array, sha256: string) => {
    const expectedBytes = bytes.byteLength;
    await store.put(path, bytes);
    const received = await store.read(path);
    if (
      received.byteLength !== expectedBytes ||
      NodeCrypto.createHash("sha256").update(received).digest("hex") !== sha256
    )
      throw new Error("HARNESS_ARTIFACT_UPLOAD_READBACK_FAILED");
  };
  for (const path of Object.keys(artifact.manifest.files).sort()) {
    const bytes = await artifact.read(path);
    files[path] = await writeChunkedAsset(bytes, key(path), put);
  }
  const manifest = serializeHarnessReleaseArtifactManifest(artifact.manifest);
  files[HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH] = await writeChunkedAsset(
    manifest,
    key(HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH),
    put,
  );
  const assetIndex = {
    schemaVersion: 1 as const,
    projectId,
    artifactRef: selected.artifactRef,
    sourceIdentity: selected.sourceIdentity,
    files,
  };
  const source = createHarnessArtifactAssetSource(
    {
      fetch: async (request) => {
        const path = new URL(request.url).pathname
          .slice(1)
          .split("/")
          .map(decodeURIComponent)
          .join("/");
        return new Response(Uint8Array.from(await store.read(path)).buffer);
      },
    },
    projectId,
    assetIndex,
  );
  await openHarnessReleaseArtifact(selected, source);
  return {
    ...selected,
    assetIndex,
    projectId,
    files: Object.keys(artifact.manifest.files).length,
    bytes: Object.values(artifact.manifest.files).reduce((total, file) => total + file.bytes, 0),
  };
};

/** Writes only into the deployment asset directory; existing content must match its pin. */
export const directoryHarnessArtifactStore = (
  directory: string,
): HarnessArtifactPublicationStore => {
  const root = NodePath.resolve(directory);
  const file = (key: string) => NodePath.join(root, ...assertAssetPath(key).split("/"));
  return {
    put: async (key, bytes) => {
      const target = file(key);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      try {
        await NodeFSP.writeFile(target, bytes, { flag: "wx", mode: 0o444 });
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
        const existing = await NodeFSP.readFile(target);
        if (!existing.equals(bytes)) throw new Error("HARNESS_ARTIFACT_ASSET_COLLISION", { cause });
      }
    },
    read: (key) => NodeFSP.readFile(file(key)),
  };
};
