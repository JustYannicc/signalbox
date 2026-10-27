import type { ProgramSeed } from "../HarnessSessionHost.ts";
import type { HarnessCProductProvider } from "../HarnessProcessResume.ts";
import type {
  HarnessCProductAccessService,
  HarnessCProductExecutorService,
  HarnessCProductMachineService,
  HarnessCProductModelService,
  HarnessCProductNativeCheckpointService,
  HarnessCProductProgramService,
  HarnessCProductReleaseService,
  HarnessCProductTurnGrantSource,
} from "./contracts.ts";
import type { MachineProgramInventory } from "../../computer/MachineProgramInventory.ts";

import {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  HarnessCProductCapabilityError,
  requireHarnessCProductCapability,
} from "./capabilityBinding.ts";
export {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  HarnessCProductCapabilityError,
} from "./capabilityBinding.ts";

export interface HarnessCProductCapabilities<G> {
  readonly release: HarnessCProductReleaseService;
  readonly nativeCheckpoint: HarnessCProductNativeCheckpointService;
  readonly access: HarnessCProductAccessService<G>;
  readonly programs: HarnessCProductProgramService;
  readonly machine: HarnessCProductMachineService;
  readonly model: HarnessCProductModelService;
  readonly executor: HarnessCProductExecutorService<G>;
  readonly turnGrantSource?: HarnessCProductTurnGrantSource<G>;
}

/** Narrows only named, constructor supplied platform stubs to their local RPC methods. */
export function narrowHarnessCProductCapabilities<G>(
  supplied: Readonly<Record<string, Fetcher>> | undefined,
): HarnessCProductCapabilities<G> {
  if (supplied === undefined)
    throw new HarnessCProductCapabilityError("HARNESS_C_PRODUCT_CAPABILITIES");
  const release = requireHarnessCProductCapability<HarnessCProductReleaseService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.release,
    ["getArtifact", "loaderConfig", "readArtifact", "readArtifactChunk"],
  );
  const nativeCheckpoint = requireHarnessCProductCapability<HarnessCProductNativeCheckpointService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint,
    ["read"],
  );
  const access = requireHarnessCProductCapability<HarnessCProductAccessService<G>>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.access,
    ["resolveInitialAccess", "resolveTurnAccess"],
  );
  const programs = requireHarnessCProductCapability<HarnessCProductProgramService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs,
    ["catalog", "read"],
  );
  const machine = requireHarnessCProductCapability<HarnessCProductMachineService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine,
    ["inventory"],
  );
  const model = requireHarnessCProductCapability<HarnessCProductModelService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.model,
    ["fetch"],
  );
  const executor = requireHarnessCProductCapability<HarnessCProductExecutorService<G>>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor,
    ["forward"],
  );
  const turnGrantSource =
    supplied[HARNESS_C_PRODUCT_CAPABILITY_KEYS.turnGrantSource] === undefined
      ? undefined
      : requireHarnessCProductCapability<HarnessCProductTurnGrantSource<G>>(
          supplied,
          HARNESS_C_PRODUCT_CAPABILITY_KEYS.turnGrantSource,
          ["issue"],
        );
  return {
    release,
    nativeCheckpoint,
    access,
    programs,
    machine,
    model,
    executor,
    ...(turnGrantSource === undefined ? {} : { turnGrantSource }),
  };
}

export async function productReleaseBindings(
  provider: HarnessCProductProvider,
  service: HarnessCProductReleaseService,
) {
  return {
    getArtifact: (selectedProvider: HarnessCProductProvider, releaseId: string) =>
      service.getArtifact(selectedProvider, releaseId),
    loadOptions: async () => {
      const config = await service.loaderConfig(provider);
      return {
        source: {
          read: (artifactRef: string, path: string) => service.readArtifact(artifactRef, path),
          readRange: (artifactRef: string, path: string, offset: number, length: number) =>
            service.readArtifactChunk(artifactRef, path, offset, length),
        },
        trustedComputer: config.trustedComputer,
        maxPreparedModuleBytes: config.maxPreparedModuleBytes,
      };
    },
  };
}

export async function productProgramBindings(
  provider: HarnessCProductProvider,
  service: HarnessCProductProgramService,
): Promise<{
  readonly codes: Awaited<ReturnType<typeof service.catalog>>["codes"];
  readonly seed: ProgramSeed;
}> {
  const catalog = await service.catalog(provider);
  return {
    codes: catalog.codes,
    seed: {
      sourceIdentity: catalog.sourceIdentity,
      files: catalog.files,
      read: async (path, signal) => {
        signal.throwIfAborted();
        const bytes = await service.read(path);
        signal.throwIfAborted();
        return bytes;
      },
    },
  };
}

export const productMachineInventory = (
  provider: HarnessCProductProvider,
  service: HarnessCProductMachineService,
): Promise<MachineProgramInventory> => service.inventory(provider);

export const productModelTransport = (service: HarnessCProductModelService) => (request: Request) =>
  service.fetch(request);
