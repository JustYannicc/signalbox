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

export interface ClaudeProductOwnerRuntime {
  readonly loader: WorkerLoader;
  readonly facets: DurableObjectState["facets"];
  readonly code: {
    readonly kernel: WorkerLoaderWorkerCode;
    readonly cli: WorkerLoaderWorkerCode;
    readonly computer: WorkerLoaderWorkerCode;
    readonly sdk: WorkerLoaderWorkerCode;
  };
}

type KernelFacet = InstanceType<ReturnType<typeof createClaudeKernelFacetClass>>;

const versions = new WeakMap<WorkerLoaderWorkerCode, Promise<string>>();
/** The loader keeps a Worker under its key across deploys, so a key names its code too. */
const codeVersion = (code: WorkerLoaderWorkerCode) => {
  let version = versions.get(code);
  if (version === undefined) {
    version = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(code)))
      .then((digest) =>
        Array.from(new Uint8Array(digest).subarray(0, 8), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      );
    versions.set(code, version);
  }
  return version;
};
type ComputerOwner = ComputerProgramOwnerPort & {
  configure(input: ComputerExecutionConfiguration): Promise<void>;
};

/**
 * Normal thread startup provisions each owner from its own registered module map. An owner's
 * Worker is keyed by its code, so no release's CLI runs beside another's kernel; its facet keeps
 * its name, and with it its storage, across releases.
 */
export async function createClaudeProductOwners(runtime: ClaudeProductOwnerRuntime, name: string) {
  const version = {
    kernel: await codeVersion(runtime.code.kernel),
    cli: await codeVersion(runtime.code.cli),
    computer: await codeVersion(runtime.code.computer),
    sdk: await codeVersion(runtime.code.sdk),
  };
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
    const worker = runtime.loader.get(`${key}:${version[role]}`, () => runtime.code[role]);
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
    const sdkWorker = runtime.loader.get(`${name}:sdk:${version.sdk}`, () => runtime.code.sdk);
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
