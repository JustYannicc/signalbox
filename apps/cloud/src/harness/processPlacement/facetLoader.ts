import {
  createHarnessProcessFacetAdapter,
  type HarnessProcessFacetInvokeInput as FacetInvokeInput,
} from "../HarnessProcessFacetObject.ts";
import type { HarnessProcessFacetLocator, HarnessProcessPreparedFacet } from "./contracts.ts";
import type { HarnessRequestFacetObject } from "../HarnessRequestFacetObject.ts";
import {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  requireHarnessCProductCapability,
} from "../productBootstrap/capabilityBinding.ts";
import {
  assertHarnessProcessModuleAssets,
  materializeHarnessProcessModules,
  snapshotHarnessProcessModules,
} from "./moduleCode.ts";
import type { HarnessProcessReleaseAssetChunkReader } from "./preparedReleaseAsset.ts";
import {
  createHarnessProcessFacetEnvironment,
  type HarnessProcessExecutionEnvironment,
  type HarnessProcessExecutionProcessInput,
  type HarnessProcessExecutionFacetCodeInput,
} from "./executionEnvironment.ts";

export type HarnessProcessFacetStub = Pick<
  HarnessRequestFacetObject,
  "prepareInert" | "startFresh" | "run" | "dispose"
> &
  Rpc.DurableObjectBranded & {
    identity(): Promise<{ readonly facetNonce: string }>;
    /** Implemented only by a host that can observe its verified prepared artifact load. */
    loadedPreparedRelease: () => Promise<unknown>;
  };

export function createHarnessProcessFacet(
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  process: HarnessProcessExecutionProcessInput,
  identity: HarnessProcessFacetLocator,
): HarnessProcessPreparedFacet<FacetInvokeInput> & {
  readonly readLoadedPreparedRelease: () => Promise<unknown>;
} {
  const facet = createHarnessProcessFacetStub(context, environment, process, identity);
  return {
    ...createHarnessProcessFacetAdapter(identity, facet),
    async readLoadedPreparedRelease() {
      try {
        return await facet.loadedPreparedRelease();
      } catch {
        return undefined;
      }
    },
  };
}

export function createHarnessProcessFacetStub(
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  process: HarnessProcessExecutionFacetCodeInput,
  identity: HarnessProcessFacetLocator,
): HarnessProcessFacetStub {
  if (
    !process.mainModule ||
    !Object.hasOwn(process.modules, process.mainModule) ||
    !process.entrypoint
  )
    throw new TypeError("Process execution code must include a main module and entrypoint.");
  if (identity.facetKey !== identity.loaderId)
    throw new TypeError("A process facet key must use its ProcessSlots loader ID.");
  const modules = snapshotHarnessProcessModules(process.modules, process.mainModule);
  if (modules === undefined)
    throw new TypeError(
      "Process execution code must use JavaScript and Wasm byte modules with a JavaScript main.",
    );
  const hasPreparedAssets = Object.values(modules).some(
    (module) => typeof module !== "string" && "preparedReleaseAsset" in module,
  );
  if (hasPreparedAssets) {
    if (process.productBootstrap === undefined || process.targetPreparedRelease === undefined)
      throw new TypeError("Prepared process facet assets require a selected product release.");
    assertHarnessProcessModuleAssets(modules, process.targetPreparedRelease);
  }
  const facetEnvironment = createHarnessProcessFacetEnvironment(
    process,
    environment,
    identity,
    context,
  );
  const releaseService = hasPreparedAssets
    ? requireHarnessCProductCapability<{
        readonly readArtifactChunk: HarnessProcessReleaseAssetChunkReader;
      }>(environment.HARNESS_C_PRODUCT_CAPABILITIES, HARNESS_C_PRODUCT_CAPABILITY_KEYS.release, [
        "readArtifactChunk",
      ])
    : undefined;
  const readArtifactChunk =
    releaseService === undefined
      ? undefined
      : (artifactRef: string, path: string, offset: number, length: number) =>
          releaseService.readArtifactChunk(artifactRef, path, offset, length);
  const worker = environment.LOADER.get(identity.loaderId, async () => {
    const workerModules = await materializeHarnessProcessModules(
      modules,
      process.targetPreparedRelease,
      readArtifactChunk,
    );
    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: process.mainModule,
      modules: workerModules,
      env: facetEnvironment,
      globalOutbound: null,
    };
    return workerCode;
  });
  const facetClass = worker.getDurableObjectClass<HarnessProcessFacetStub>(process.entrypoint, {
    props: {
      facetKey: identity.facetKey,
      loaderId: identity.loaderId,
      shardOwner: identity.shardOwner,
    },
  });
  const facet = context.facets.get<HarnessProcessFacetStub>(identity.facetKey, () => ({
    class: facetClass,
  }));
  return facet;
}
