import { describe, expect, it } from "@effect/vitest";
import { loadMaterial, releaseMaterial } from "../processResume/tests/releaseMaterial.ts";
import { selectHarnessCProductRelease } from "../HarnessCProductRelease.ts";

describe("selected product release", () => {
  it("loads from the exact artifact lookup and its pinned source configuration", async () => {
    const material = await releaseMaterial("fixture source", "selected");
    const expected = await loadMaterial(material);
    const reads: string[] = [];
    const calls: Array<readonly [string, string]> = [];
    const selected = await selectHarnessCProductRelease({
      provider: "claude-code",
      preparedReleaseId: material.artifact.releaseId,
      expected,
      bindings: {
        getArtifact: async (provider, releaseId) => {
          calls.push([provider, releaseId]);
          return material.artifact;
        },
        loadOptions: async () => ({
          trustedComputer: material.trustedComputer,
          maxPreparedModuleBytes: Object.values(material.files).reduce(
            (total, bytes) => total + bytes.byteLength,
            0,
          ),
          source: {
            read: async (artifactRef, path) => {
              reads.push(artifactRef + ":" + path);
              const bytes = material.files[path];
              if (bytes === undefined) throw new Error("Missing artifact file");
              return bytes;
            },
          },
        }),
      },
    });

    expect(calls).toEqual([["claude-code", material.artifact.releaseId]]);
    expect(selected.artifact).toEqual(material.artifact);
    expect(selected.release.identity).toEqual({
      artifactRef: material.artifact.artifactRef,
      artifactHash: material.artifact.artifactHash,
      sourceIdentity: material.artifact.sourceIdentity,
    });
    expect(reads).toEqual([]);
  });

  it("fails closed on a missing or changed full artifact and a wrong computer pin", async () => {
    const material = await releaseMaterial("fixture source", "selected");
    const expected = await loadMaterial(material);
    const bindings = {
      getArtifact: async () => material.artifact,
      loadOptions: async () => ({
        trustedComputer: material.trustedComputer,
        maxPreparedModuleBytes: 1024,
        source: { read: async () => new Uint8Array() },
      }),
    };
    const input = {
      provider: "claude-code" as const,
      preparedReleaseId: material.artifact.releaseId,
      expected,
      bindings,
    };

    await expect(
      selectHarnessCProductRelease({
        ...input,
        bindings: { ...bindings, getArtifact: async () => null },
      }),
    ).rejects.toThrow("artifact is missing");
    await expect(
      selectHarnessCProductRelease({
        ...input,
        bindings: {
          ...bindings,
          getArtifact: async () => ({ ...material.artifact, fixtureIdentity: "different" }),
        },
      }),
    ).rejects.toThrow("differs from the expected identity");
    await expect(
      selectHarnessCProductRelease({
        ...input,
        bindings: {
          ...bindings,
          loadOptions: async () => ({
            trustedComputer: {
              ...material.trustedComputer,
              sourceIdentity: "f".repeat(64),
            },
            maxPreparedModuleBytes: 1024,
            source: { read: async () => new Uint8Array() },
          }),
        },
      }),
    ).rejects.toThrow("computer pin does not match");
  });
});
