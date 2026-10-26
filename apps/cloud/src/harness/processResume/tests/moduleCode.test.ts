import { describe, expect, it } from "vite-plus/test";
import {
  sameHarnessProcessResumeOperation,
  snapshotHarnessProcessResumeOperation,
} from "../../HarnessProcessResume.ts";

const wasmBytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
const publisher = {
  generation: 2,
  facetNonce: "previous-facet",
  publisherKey: "publisher-key-" + "a".repeat(32),
};
const control = {
  ownerId: "owner",
  incarnationId: "incarnation",
  epoch: 2,
  controlKey: "control-key-" + "b".repeat(32),
};
const reference = (id: string) => ({ id, sha256: "a".repeat(64), bytes: 4 });

function operation(modules: Record<string, unknown>) {
  return {
    runId: "run",
    previousProcessId: "process",
    previousOperationId: "previous-operation",
    previousStepId: "request",
    productBootstrap: {
      provider: "codex",
      preparedReleaseId: "release",
      restoreMode: "cross-variant-fresh-boot",
    },
    transition: {
      operationId: "replacement",
      control,
      publisher,
      nextControl: { ...control, epoch: 3 },
      expectedFacetGeneration: 2,
      targetPreparedRelease: {
        artifact: {
          provider: "codex",
          releaseId: "release",
          artifactHash: "a".repeat(64),
          artifactRef: "sha256:" + "a".repeat(64),
          sourceIdentity: "source",
          fixtureIdentity: "fixture",
          createdAt: "2026-10-27T00:00:00.000Z",
        },
        plan: {
          release: {
            harness: "codex",
            version: "1.0.0",
            manifestSha256: "a".repeat(64),
            modules: {},
          },
          sourceIdentity: "source",
          computer: { sourceIdentity: "computer", manifestSha256: "b".repeat(64) },
          preparedModules: {},
        },
      },
    },
    runStore: {
      runId: "run",
      processId: "process",
      processOperationId: "previous-operation",
      transitionOperationId: "replacement",
      controlKey: "run-control-" + "c".repeat(32),
      supervisor: { supervisorKey: "supervisor-" + "d".repeat(32), epoch: 2, claimId: "claim" },
      currentPublisher: publisher,
      nextPublisherKey: "next-publisher-" + "e".repeat(32),
      request: { requestId: "request", input: reference("input") },
      checkpoint: { native: reference("native"), filesystem: reference("files") },
    },
    facet: {
      processId: "process",
      codeId: "code",
      residentBytes: 1,
      mainModule: "main.mjs",
      modules,
      entrypoint: "Facet",
    },
  };
}

const javascript = "export default {}";
const snapshot = (modules: Record<string, unknown>) => {
  const result = snapshotHarnessProcessResumeOperation(operation(modules));
  if (result === undefined) throw new Error("Valid mixed module input was rejected.");
  return result;
};

describe("C Wasm module input", () => {
  it("snapshots Wasm bytes independently before caller mutation", () => {
    const bytes = wasmBytes();
    const result = snapshot({ "main.mjs": javascript, "engine.wasm": { wasm: bytes } });
    const module = result.facet.modules["engine.wasm"];
    if (module === undefined || typeof module === "string" || !("wasm" in module))
      throw new Error("The snapshotted Wasm module is missing.");
    expect(module.wasm).not.toBe(bytes);
    new Uint8Array(bytes)[0] = 255;
    expect([...new Uint8Array(module.wasm)]).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(result.facet.modules)).toBe(true);
  });

  it("compares duplicate module code by kind and bytes independently of insertion order", () => {
    const left = snapshot({ "main.mjs": { js: javascript }, "engine.wasm": { wasm: wasmBytes() } });
    const right = snapshot({
      "engine.wasm": { wasm: wasmBytes() },
      "main.mjs": { js: javascript },
    });
    expect(sameHarnessProcessResumeOperation(left, right)).toBe(true);
    const changed = new Uint8Array(wasmBytes());
    changed[7] = 1;
    const different = snapshot({
      "main.mjs": { js: javascript },
      "engine.wasm": { wasm: changed.buffer },
    });
    expect(sameHarnessProcessResumeOperation(left, different)).toBe(false);
    const otherKind = snapshot({ "main.mjs": { js: javascript }, "engine.wasm": { js: "" } });
    expect(sameHarnessProcessResumeOperation(left, otherKind)).toBe(false);
  });

  it.each([
    { wasm: new Uint8Array(wasmBytes()) },
    { wasm: wasmBytes(), js: javascript },
    { wasm: null },
    { wasm: wasmBytes(), extra: true },
  ])("rejects unsupported or ambiguous module forms before admission: %j", (module) => {
    expect(
      snapshotHarnessProcessResumeOperation(
        operation({ "main.mjs": javascript, "engine.wasm": module }),
      ),
    ).toBeUndefined();
  });

  it("requires the main module to remain JavaScript", () => {
    expect(
      snapshotHarnessProcessResumeOperation(operation({ "main.mjs": { wasm: wasmBytes() } })),
    ).toBeUndefined();
  });
});
