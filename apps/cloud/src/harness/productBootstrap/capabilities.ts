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
} from "./contracts.ts";
import type { MachineProgramInventory } from "../../computer/MachineProgramInventory.ts";

export const HARNESS_C_PRODUCT_CAPABILITY_KEYS = {
  release: "HARNESS_C_PRODUCT_RELEASES",
  nativeCheckpoint: "HARNESS_C_PRODUCT_NATIVE_CHECKPOINTS",
  access: "HARNESS_C_PRODUCT_ACCESS",
  programs: "HARNESS_C_PRODUCT_PROGRAMS",
  machine: "HARNESS_C_PRODUCT_MACHINE",
  model: "HARNESS_C_PRODUCT_MODEL",
  executor: "HARNESS_C_PRODUCT_EXECUTOR",
} as const;

export interface HarnessCProductCapabilities<G> {
  readonly release: HarnessCProductReleaseService;
  readonly nativeCheckpoint: HarnessCProductNativeCheckpointService;
  readonly access: HarnessCProductAccessService<G>;
  readonly programs: HarnessCProductProgramService;
  readonly machine: HarnessCProductMachineService;
  readonly model: HarnessCProductModelService;
  readonly executor: HarnessCProductExecutorService<G>;
}

export class HarnessCProductCapabilityError extends Error {
  readonly _tag = "HarnessCProductCapabilityError";
  readonly capability: string;

  constructor(capability: string) {
    super(`Required product bootstrap capability is missing: ${capability}.`);
    this.capability = capability;
  }
}

/** Narrows only named, constructor supplied platform stubs to their local RPC methods. */
export function narrowHarnessCProductCapabilities<G>(
  supplied: Readonly<Record<string, Fetcher>> | undefined,
): HarnessCProductCapabilities<G> {
  if (supplied === undefined)
    throw new HarnessCProductCapabilityError("HARNESS_C_PRODUCT_CAPABILITIES");
  const release = required<HarnessCProductReleaseService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.release,
    ["getArtifact", "loaderConfig", "readArtifact"],
  );
  const nativeCheckpoint = required<HarnessCProductNativeCheckpointService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint,
    ["read"],
  );
  const access = required<HarnessCProductAccessService<G>>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.access,
    ["resolveInitialAccess", "resolveTurnAccess"],
  );
  const programs = required<HarnessCProductProgramService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs,
    ["catalog", "read"],
  );
  const machine = required<HarnessCProductMachineService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine,
    ["inventory"],
  );
  const model = required<HarnessCProductModelService>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.model,
    ["fetch"],
  );
  const executor = required<HarnessCProductExecutorService<G>>(
    supplied,
    HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor,
    ["forward"],
  );
  return {
    release,
    nativeCheckpoint,
    access,
    programs,
    machine,
    model,
    executor,
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

function required<T>(
  capabilities: Readonly<Record<string, Fetcher>>,
  name: string,
  methods: readonly string[],
): T {
  const capability = capabilities[name];
  if (capability === undefined) throw new HarnessCProductCapabilityError(name);
  const service = capability as unknown as Record<string, unknown>;
  for (const method of methods) {
    if (typeof service[method] !== "function")
      throw new HarnessCProductCapabilityError(`${name}.${method}`);
  }
  return capability as unknown as T;
}
