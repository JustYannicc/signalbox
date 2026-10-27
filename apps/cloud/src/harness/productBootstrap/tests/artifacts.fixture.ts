import * as Effect from "effect/Effect";
import { createHarnessFilesStore } from "../../HarnessFilesStore.ts";
import { hostSqlite } from "../../tests/hostSqlite.ts";
import type { HarnessReleaseArtifact } from "../../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessRunArtifact } from "../../HarnessRunStore.ts";
import { loadHarnessRelease } from "../../HarnessReleaseLoader.ts";
import { productLoadedPreparedRelease } from "../../ProductHarnessProcessRelease.ts";
import { codexFixture } from "../../releaseLoader/tests/artifactFixtures.ts";
import { loadMaterial, releaseMaterial } from "../../processResume/tests/releaseMaterial.ts";

export async function releaseSource(provider: "claude-code" | "codex") {
  if (provider === "claude-code") {
    const material = await releaseMaterial("source for claude", "c-product");
    return {
      artifact: material.artifact,
      expected: await loadMaterial(material),
      trustedComputer: material.trustedComputer,
      maxPreparedModuleBytes: Object.values(material.files).reduce(
        (total, bytes) => total + bytes.byteLength,
        0,
      ),
      readArtifact: async (artifactRef: string, path: string) => {
        if (artifactRef !== material.artifact.artifactRef)
          throw new Error("The product release reader received another artifact reference.");
        const bytes = material.files[path];
        if (bytes === undefined) throw new Error("The product release file is missing.");
        return bytes.slice();
      },
    };
  }
  const fixture = await codexFixture();
  const artifact: HarnessReleaseArtifact = {
    provider: "codex",
    releaseId: "codex-c-product",
    artifactHash: fixture.options.identity.artifactHash,
    artifactRef: fixture.options.identity.artifactRef,
    sourceIdentity: fixture.options.identity.sourceIdentity,
    fixtureIdentity: "c-product-codex-fixture",
    createdAt: "2026-10-27T00:00:00.000Z",
  };
  const loaded = await loadHarnessRelease(fixture.options);
  return {
    artifact,
    expected: productLoadedPreparedRelease("codex", artifact, loaded),
    trustedComputer: fixture.options.trustedComputer,
    maxPreparedModuleBytes: fixture.options.maxPreparedModuleBytes,
    readArtifact: (artifactRef: string, path: string) =>
      fixture.options.source.read(artifactRef, path),
  };
}

export const emptyArtifact = (id: string): HarnessRunArtifact => ({
  id,
  bytes: 1,
  sha256: "a".repeat(64),
});

export const reference = async (id: string, bytes: Uint8Array): Promise<HarnessRunArtifact> => {
  const result = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return {
    id,
    bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
};

export async function prepareFilesCheckpoint(
  checkpoint: import("../../HarnessFilesStore.ts").HarnessFilesCheckpoint,
) {
  const database = hostSqlite();
  try {
    const connection = database.open();
    const store = createHarnessFilesStore(connection.storage, "checkpoint-material");
    const result = await Effect.runPromise(
      store.execute({
        type: "initialize",
        runId: "checkpoint-material",
        control: {
          ownerId: "owner",
          incarnationId: "incarnation",
          epoch: 1,
          controlKey: "c".repeat(32),
        },
        publisher: { generation: 1, facetNonce: "facet-a", publisherKey: "p".repeat(32) },
        checkpoint,
      }),
    );
    return {
      manifestSha256: result.checkpoint.manifestSha256,
      byteCount: result.files.reduce((total, file) => total + file.bytes.byteLength, 0),
    };
  } finally {
    database.dispose();
  }
}
