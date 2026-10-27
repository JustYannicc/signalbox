import { describe, expect, it } from "vite-plus/test";
import {
  sameHarnessProcessResumeOperation,
  snapshotHarnessProcessResumeOperation,
} from "../../HarnessProcessResume.ts";
import {
  HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES,
  materializeHarnessProcessModules,
  preparedReleaseAsset,
  snapshotHarnessProcessModules,
} from "../../processPlacement/moduleCode.ts";

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

function operation(
  modules: Record<string, unknown>,
  preparedModules: Record<string, unknown> = {},
) {
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
          preparedModules,
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
  it("preserves the received Wasm ArrayBuffer without creating another copy", () => {
    const bytes = wasmBytes();
    const result = snapshot({ "main.mjs": javascript, "engine.wasm": { wasm: bytes } });
    const module = result.facet.modules["engine.wasm"];
    if (module === undefined || typeof module === "string" || !("wasm" in module))
      throw new Error("The snapshotted Wasm module is missing.");
    expect(module.wasm).toBe(bytes);
    new Uint8Array(bytes)[0] = 255;
    expect([...new Uint8Array(module.wasm)]).toEqual([255, 97, 115, 109, 1, 0, 0, 0]);
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(result.facet.modules)).toBe(true);
  });

  it("keeps prepared-release modules as frozen references until materialization", async () => {
    const bytes = new Uint8Array(HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES + 1);
    bytes[0] = 0;
    bytes[1] = 97;
    bytes[2] = 115;
    bytes[3] = 109;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const artifactRef = `sha256:${"a".repeat(64)}`;
    const preparedModule = {
      component: "codex",
      name: "engine.wasm",
      path: "codex/engine.wasm",
      bytes: bytes.byteLength,
      sha256,
      type: "wasm",
    } as const;
    const release = {
      artifact: { artifactRef },
      plan: { preparedModules: { "codex/engine.wasm": preparedModule } },
    };
    const descriptor = preparedReleaseAsset(release, "codex/engine.wasm");
    const modules = snapshotHarnessProcessModules(
      { "main.mjs": javascript, "codex/engine.wasm": descriptor },
      "main.mjs",
    );
    if (modules === undefined) throw new Error("The prepared module reference was rejected.");
    const descriptorModule = modules["codex/engine.wasm"];
    if (
      descriptorModule === undefined ||
      typeof descriptorModule === "string" ||
      !("preparedReleaseAsset" in descriptorModule)
    )
      throw new Error("The prepared release descriptor is missing.");
    expect(Object.isFrozen(descriptorModule)).toBe(true);

    const reads: Array<{ readonly offset: number; readonly length: number }> = [];
    const receivedBuffers: ArrayBuffer[] = [];
    const loaded = await materializeHarnessProcessModules(
      modules,
      release,
      async (ref, path, offset, length) => {
        reads.push({ offset, length });
        expect(ref).toBe(artifactRef);
        expect(path).toBe("codex/engine.wasm");
        const chunk = bytes.slice(offset, offset + length);
        receivedBuffers.push(chunk.buffer);
        return chunk;
      },
    );
    const engine = loaded["codex/engine.wasm"];
    if (engine === undefined || typeof engine === "string" || !("wasm" in engine))
      throw new Error("The prepared Wasm payload is missing.");
    expect(reads).toEqual([
      { offset: 0, length: HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES },
      { offset: HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES, length: 1 },
    ]);
    expect(engine.wasm).not.toBe(bytes.buffer);
    expect([...new Uint8Array(engine.wasm).slice(0, 4)]).toEqual([0, 97, 115, 109]);
    expect(engine.wasm.byteLength).toBe(bytes.byteLength);
    expect(receivedBuffers.map((buffer) => buffer.byteLength)).toEqual([0, 0]);
  });

  it("materializes CJS and text assets with their declared WorkerLoader types", async () => {
    const encoder = new TextEncoder();
    const cjsSource = "module.exports = { ready: true };";
    const textSource = "lock-version = 4\n";
    const cjsBytes = encoder.encode(cjsSource);
    const textBytes = encoder.encode(textSource);
    const digest = async (bytes: Uint8Array<ArrayBuffer>) => {
      const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const artifactRef = `sha256:${"a".repeat(64)}`;
    const preparedModules = {
      "codex/bridge.cjs": {
        component: "codex",
        name: "bridge.cjs",
        path: "codex/bridge.cjs",
        bytes: cjsBytes.byteLength,
        sha256: await digest(cjsBytes),
        type: "cjs" as const,
      },
      "codex/Cargo.lock": {
        component: "codex",
        name: "Cargo.lock",
        path: "codex/Cargo.lock",
        bytes: textBytes.byteLength,
        sha256: await digest(textBytes),
        type: "text" as const,
      },
    };
    const release = { artifact: { artifactRef }, plan: { preparedModules } };
    const modules = snapshotHarnessProcessModules(
      {
        "main.mjs": javascript,
        "bridge.cjs": preparedReleaseAsset(release, "codex/bridge.cjs"),
        "Cargo.lock": preparedReleaseAsset(release, "codex/Cargo.lock"),
      },
      "main.mjs",
    );
    if (modules === undefined) throw new Error("The prepared module references were rejected.");

    const paths: string[] = [];
    const loaded = await materializeHarnessProcessModules(
      modules,
      release,
      async (ref, path, offset, length) => {
        expect(ref).toBe(artifactRef);
        paths.push(path);
        if (path === "codex/bridge.cjs") return cjsBytes.slice(offset, offset + length);
        if (path === "codex/Cargo.lock") return textBytes.slice(offset, offset + length);
        throw new Error(`Unexpected prepared asset ${path}.`);
      },
    );

    expect(paths).toEqual(["codex/bridge.cjs", "codex/Cargo.lock"]);
    expect(loaded["bridge.cjs"]).toEqual({ cjs: cjsSource });
    expect(loaded["Cargo.lock"]).toEqual({ text: textSource });
  });

  it("rejects a prepared-release descriptor that disagrees with the selected plan", () => {
    const artifactRef = `sha256:${"a".repeat(64)}`;
    const preparedModule = {
      component: "codex",
      name: "engine.wasm",
      path: "codex/engine.wasm",
      bytes: 8,
      sha256: "b".repeat(64),
      type: "wasm",
    } as const;
    const descriptor = preparedReleaseAsset(
      {
        artifact: { artifactRef },
        plan: { preparedModules: { "codex/engine.wasm": preparedModule } },
      },
      "codex/engine.wasm",
    );
    const result = snapshotHarnessProcessResumeOperation(
      operation(
        { "main.mjs": javascript, "codex/engine.wasm": descriptor },
        { "codex/engine.wasm": preparedModule },
      ),
    );
    expect(result).toBeDefined();
    const corrupted = structuredClone(
      operation(
        { "main.mjs": javascript, "codex/engine.wasm": descriptor },
        { "codex/engine.wasm": { ...preparedModule, sha256: "c".repeat(64) } },
      ),
    );
    expect(snapshotHarnessProcessResumeOperation(corrupted)).toBeUndefined();
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
