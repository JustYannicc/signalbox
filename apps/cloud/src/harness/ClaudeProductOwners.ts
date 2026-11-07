import type {
  ComputerExecutionObject,
  ComputerExecutionConfiguration,
} from "../computer/ComputerExecutionObject.ts";
import { disposeWorkerLoaderStubs } from "../computer/WorkerLoaderResources.ts";
import type { ComputerProgramOwnerPort } from "../kernel/KernelComputerAdmissionPort.ts";
import type { createClaudeKernelFacetClass } from "./ClaudeKernelSession.ts";
import type { ClaudeKernelSessionPort } from "./ClaudeKernelSessionPort.ts";
import type { createClaudeCliFacetClass } from "./ClaudeCliSession.ts";
import type { ClaudeCliHost } from "./ClaudeCliKernelPort.ts";
import type { ClaudeSdkHostService } from "./ClaudeSdkHostProtocol.ts";

/** Builds one owner's code from assets or bytes. Only the loader calls it, once per load. */
export type ClaudeOwnerCodeFactory = () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>;

export interface ClaudeProductOwnerRuntime {
  readonly loader: WorkerLoader;
  readonly facets: DurableObjectState["facets"];
  /**
   * Factories, never code: the CLI alone is about 49 MB of module source, and a thread that held it
   * for its owners' lifetime would spend most of its 128 MiB isolate on bytes the loader already has.
   */
  readonly code: {
    readonly kernel: ClaudeOwnerCodeFactory;
    readonly cli: ClaudeOwnerCodeFactory;
    readonly computer: ClaudeOwnerCodeFactory;
    readonly sdk: ClaudeOwnerCodeFactory;
  };
  /**
   * Each owner bundle's digest, from the build that produced it. The loader keeps a Worker under
   * its key across deploys, so the key must name the code; hashing the bundles here would copy
   * tens of MB inside a thread's memory limit.
   */
  readonly versions: {
    readonly kernel: string;
    readonly cli: string;
    readonly computer: string;
    readonly sdk: string;
  };
}

type KernelFacet = InstanceType<ReturnType<typeof createClaudeKernelFacetClass>>;
type ComputerOwner = ComputerProgramOwnerPort & {
  configure(input: ComputerExecutionConfiguration): Promise<void>;
};

/**
 * Normal thread startup provisions each owner from its own registered module map. Each Worker is
 * keyed by its bundle's build digest, and the CLI's also by the Claude release it runs, so the
 * loader never pairs one release's CLI with another's kernel. Each factory runs only inside the
 * loader's own callback, so no owner's code is built or kept here.
 */
export function createClaudeProductOwners(
  runtime: ClaudeProductOwnerRuntime,
  name: string,
  release: string,
) {
  const version = { ...runtime.versions, cli: `${runtime.versions.cli}:${release}` };
  const stubs: unknown[] = [];
  const facets: string[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const key of facets.toReversed()) {
      try {
        runtime.facets.abort(key, "Claude product owner was retired");
      } catch (cause) {
        failures.push(cause);
      }
      try {
        runtime.facets.delete(key);
      } catch (cause) {
        failures.push(cause);
      }
    }
    facets.length = 0;
    try {
      disposeWorkerLoaderStubs(...stubs.toReversed());
    } catch (cause) {
      failures.push(cause);
    }
    stubs.length = 0;
    if (failures.length > 0)
      throw new AggregateError(failures, "Claude product owners could not retire");
  };
  const openFacet = <T extends Rpc.DurableObjectBranded>(
    role: "kernel" | "computer" | "cli",
    entrypoint: string,
  ) => {
    const key = `${name}:${role}`;
    const worker = runtime.loader.get(`${key}:${version[role]}`, runtime.code[role]);
    stubs.push(worker);
    const facetClass = worker.getDurableObjectClass<T>(entrypoint);
    stubs.push(facetClass);
    facets.push(key);
    const facet = runtime.facets.get<T>(key, () => ({ class: facetClass }));
    stubs.push(facet);
    return facet;
  };
  try {
    const kernel = openFacet<KernelFacet>("kernel", "ClaudeKernelFacet");
    const cli = openFacet<InstanceType<ReturnType<typeof createClaudeCliFacetClass>>>(
      "cli",
      "ClaudeCliFacet",
    );
    const computer = openFacet<ComputerExecutionObject>("computer", "ComputerExecutionObject");
    const sdkWorker = runtime.loader.get(`${name}:sdk:${version.sdk}`, runtime.code.sdk);
    stubs.push(sdkWorker);
    const sdk = sdkWorker.getEntrypoint();
    stubs.push(sdk);
    return {
      kernel: kernel as unknown as ClaudeKernelSessionPort,
      cliHost: cli as unknown as ClaudeCliHost,
      commands: computer as unknown as ComputerOwner,
      sdkHost: sdk as unknown as ClaudeSdkHostService,
      dispose,
    };
  } catch (cause) {
    try {
      dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        "Claude product owner startup and cleanup failed",
        { cause: cleanup },
      );
    }
    throw cause;
  }
}
