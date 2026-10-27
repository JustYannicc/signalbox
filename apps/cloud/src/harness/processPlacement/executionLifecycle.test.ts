import { describe, expect, it, vi } from "vite-plus/test";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../HarnessCProductCapabilities.ts";
import { createHarnessProcessFacet as createFacet } from "../HarnessProcessFacet.ts";
import type { HarnessProcessExecutionEnvironment } from "../HarnessProcessPlacement.ts";
import { preparedReleaseAsset } from "../HarnessProcessPlacement.ts";

describe("process facet module loading", () => {
  it("reads prepared assets only on a loader miss and passes the owned Wasm buffer through", async () => {
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
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
    const targetPreparedRelease = {
      artifact: {
        provider: "codex",
        releaseId: "codex-release",
        artifactHash: "a".repeat(64),
        artifactRef,
        sourceIdentity: "source",
        fixtureIdentity: "fixture",
        createdAt: "2026-10-27T00:00:00.000Z",
      },
      plan: {
        release: {
          harness: "codex",
          version: "1",
          manifestSha256: "a".repeat(64),
          modules: {},
        },
        sourceIdentity: "source",
        computer: { sourceIdentity: "computer", manifestSha256: "b".repeat(64) },
        preparedModules: { "codex/engine.wasm": preparedModule },
      },
    } as const;
    const returnedChunks: Uint8Array[] = [];
    const readArtifactChunk = vi.fn(
      async (_ref: string, _path: string, offset: number, length: number) => {
        const chunk = bytes.slice(offset, offset + length);
        returnedChunks.push(chunk);
        return chunk;
      },
    );
    const capabilities = {
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.release]: {
        getArtifact: vi.fn(),
        loaderConfig: vi.fn(),
        readArtifact: vi.fn(),
        readArtifactChunk,
      },
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint]: { read: vi.fn() },
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.access]: {
        resolveInitialAccess: vi.fn(),
        resolveTurnAccess: vi.fn(),
      },
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs]: { catalog: vi.fn(), read: vi.fn() },
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine]: { inventory: vi.fn() },
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.model]: { fetch: vi.fn() },
      [HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor]: { forward: vi.fn() },
    };
    const worker = {
      getDurableObjectClass: vi.fn(
        () =>
          class Facet {
            readonly fixtureName = "process-facet";
          },
      ),
    };
    const loads = new Map<string, Promise<WorkerLoaderWorkerCode>>();
    const get = vi.fn(
      (name: string, factory: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) => {
        if (!loads.has(name)) loads.set(name, Promise.resolve().then(factory));
        return worker;
      },
    );
    const facet = {
      identity: vi.fn(() => ({ facetNonce: "facet-nonce" })),
      prepareInert: vi.fn(),
      run: vi.fn(),
      dispose: vi.fn(),
      loadedPreparedRelease: vi.fn(),
    };
    const context = {
      facets: { get: vi.fn(() => facet) },
    } as unknown as DurableObjectState;
    const environment = {
      LOADER: { get },
      HARNESS_C_PRODUCT_CAPABILITIES: capabilities,
    } as unknown as HarnessProcessExecutionEnvironment;
    const process = {
      processId: "process",
      codeId: "codex-release",
      residentBytes: 1,
      nativeSessionId: "native-session",
      checkpointId: "checkpoint",
      manifestRevision: "manifest",
      operationId: "operation",
      priorFacetNonce: "prior-facet",
      expectedFacetGeneration: 1,
      mainModule: "main.mjs",
      modules: {
        "main.mjs": "export default {}",
        "codex-engine.wasm": preparedReleaseAsset(targetPreparedRelease, "codex/engine.wasm"),
      },
      entrypoint: "Facet",
      productBootstrap: {
        provider: "codex",
        preparedReleaseId: "codex-release",
        restoreMode: "same-variant-serialized-checkpoint",
      },
      targetPreparedRelease,
    } as const;
    const identity = { shardOwner: "shard", loaderId: "stable-loader", facetKey: "stable-loader" };

    createFacet(context, environment, process, identity);
    expect(readArtifactChunk).not.toHaveBeenCalled();
    const firstCode = await loads.get(identity.loaderId);
    const loadedWasm = firstCode?.modules["codex-engine.wasm"];
    if (loadedWasm === undefined || typeof loadedWasm === "string" || !("wasm" in loadedWasm))
      throw new Error("The loader factory did not materialize the prepared Wasm asset.");
    expect(loadedWasm.wasm).toBe(returnedChunks[0]?.buffer);
    expect(readArtifactChunk).toHaveBeenCalledTimes(1);

    createFacet(context, environment, process, identity);
    expect(get).toHaveBeenCalledTimes(2);
    expect(loads.size).toBe(1);
    expect(readArtifactChunk).toHaveBeenCalledTimes(1);

    const releaseOnlyEnvironment = {
      ...environment,
      HARNESS_C_PRODUCT_CAPABILITIES: {
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.release]:
          capabilities[HARNESS_C_PRODUCT_CAPABILITY_KEYS.release],
      },
    } as unknown as HarnessProcessExecutionEnvironment;
    createFacet(context, releaseOnlyEnvironment, process, identity);
    expect(get).toHaveBeenCalledTimes(3);
    expect(readArtifactChunk).toHaveBeenCalledTimes(1);

    const missingCapabilityEnvironment = { ...environment };
    delete missingCapabilityEnvironment.HARNESS_C_PRODUCT_CAPABILITIES;
    expect(() => createFacet(context, missingCapabilityEnvironment, process, identity)).toThrow(
      "Required product bootstrap capability is missing: HARNESS_C_PRODUCT_CAPABILITIES",
    );
    expect(() =>
      createFacet(
        context,
        {
          ...environment,
          HARNESS_C_PRODUCT_CAPABILITIES: {
            [HARNESS_C_PRODUCT_CAPABILITY_KEYS.release]: {} as Fetcher,
          },
        },
        process,
        identity,
      ),
    ).toThrow(
      "Required product bootstrap capability is missing: HARNESS_C_PRODUCT_RELEASES.readArtifactChunk",
    );
    expect(get).toHaveBeenCalledTimes(3);
  });
});
