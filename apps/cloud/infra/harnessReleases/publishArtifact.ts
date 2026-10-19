import * as NodeCrypto from "node:crypto";
import {
  HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH,
  openHarnessReleaseArtifact,
  serializeHarnessReleaseArtifactManifest,
  type HarnessReleaseArtifactIdentity,
} from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { harnessArtifactKey } from "../../src/harnessReleases/HarnessReleaseArtifactBucket.ts";
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
  const selected = { ...identity };
  const { store, projectId, prefix } = destination;
  const local = artifactDirectorySource(directory);
  const artifact = await openHarnessReleaseArtifact(selected, local);
  const key = (path: string) => harnessArtifactKey(projectId, selected.artifactRef, path, prefix);
  const remote = {
    read: async (_reference: string, path: string) => store.read(key(path)),
  };
  for (const path of Object.keys(artifact.manifest.files).sort()) {
    const bytes = await artifact.read(path);
    await store.put(key(path), bytes);
    const received = await remote.read(selected.artifactRef, path);
    const expected = artifact.manifest.files[path]!;
    if (
      received.byteLength !== expected.bytes ||
      NodeCrypto.createHash("sha256").update(received).digest("hex") !== expected.sha256
    )
      throw new Error("HARNESS_ARTIFACT_UPLOAD_READBACK_FAILED");
  }
  const manifest = serializeHarnessReleaseArtifactManifest(artifact.manifest);
  await store.put(key(HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH), manifest);
  await openHarnessReleaseArtifact(selected, remote);
  return {
    ...selected,
    projectId,
    files: Object.keys(artifact.manifest.files).length,
    bytes: Object.values(artifact.manifest.files).reduce((total, file) => total + file.bytes, 0),
  };
};

/** Uses the existing Cloudflare account token; the runtime reads the bucket through its binding. */
export const cloudflareHarnessArtifactStore = (input: {
  readonly account: string;
  readonly bucket: string;
  readonly token: string;
  readonly jurisdiction?: "default" | "eu";
  readonly fetcher?: typeof fetch;
}): HarnessArtifactPublicationStore => {
  if (
    !/^[a-f0-9]{32}$/u.test(input.account) ||
    !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u.test(input.bucket) ||
    input.token.trim() === ""
  )
    throw new Error("HARNESS_ARTIFACT_STORAGE_CONFIGURATION_INVALID");
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.account}/r2/buckets/${input.bucket}/objects/`;
  const fetcher = input.fetcher ?? fetch;
  const request = async (key: string, bytes?: Uint8Array) => {
    const response = await fetcher(base + key.split("/").map(encodeURIComponent).join("/"), {
      method: bytes === undefined ? "GET" : "PUT",
      headers: {
        authorization: `Bearer ${input.token}`,
        "cf-r2-jurisdiction": input.jurisdiction ?? "eu",
        ...(bytes === undefined ? {} : { "content-type": "application/octet-stream" }),
      },
      ...(bytes === undefined ? {} : { body: Uint8Array.from(bytes).buffer }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`HARNESS_ARTIFACT_STORAGE_HTTP_${response.status}`);
    return response;
  };
  return {
    put: async (key, bytes) => {
      const response = await request(key, bytes);
      const result: unknown = await response.json();
      if (
        result === null ||
        typeof result !== "object" ||
        !Object.hasOwn(result, "success") ||
        Reflect.get(result, "success") !== true
      )
        throw new Error("HARNESS_ARTIFACT_STORAGE_WRITE_REJECTED");
    },
    read: async (key) => new Uint8Array(await (await request(key)).arrayBuffer()),
  };
};
