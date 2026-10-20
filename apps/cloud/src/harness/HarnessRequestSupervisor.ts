import type { HarnessRequestFacet } from "./HarnessRequestFacet.ts";
import type { HarnessRequestFacetObject } from "./HarnessRequestFacetObject.ts";

export interface HarnessRequestSupervisorOptions {
  readonly facets: DurableObjectFacets;
  readonly loader: Pick<WorkerLoader, "get">;
  readonly name: string;
  readonly applicationKey: string;
  readonly entrypoint: string;
  readonly code: WorkerLoaderWorkerCode;
  readonly cpuMs?: number;
}

/** The controller owns generation changes. This replaceable parent holds no launch authority. */
export function createHarnessRequestSupervisor(options: HarnessRequestSupervisorOptions) {
  const cpuMs = options.cpuMs ?? 300000;
  if (
    !options.name ||
    !options.applicationKey ||
    !options.entrypoint ||
    !Number.isSafeInteger(cpuMs) ||
    cpuMs <= 0 ||
    cpuMs > 300000 ||
    (options.code.limits?.cpuMs !== undefined && options.code.limits.cpuMs !== cpuMs) ||
    !Object.hasOwn(options.code.modules, options.code.mainModule)
  )
    throw new Error("Harness facet application or CPU limit is invalid.");
  const worker = options.loader.get(options.applicationKey, () => ({
    ...options.code,
    globalOutbound: null,
    limits: { ...options.code.limits, cpuMs },
  }));
  const get = () =>
    options.facets.get<HarnessRequestFacetObject>(options.name, () => ({
      class: worker.getDurableObjectClass<HarnessRequestFacetObject>(options.entrypoint, {
        limits: { cpuMs },
      }),
    }));
  return {
    identity: () => get().identity(),
    // Every call opens a new facet request. No old request or promise is a recovery handle.
    run: (input: Parameters<HarnessRequestFacet["run"]>[0]) => get().run(input),
    dispose: (expectedFacetNonce: string) => get().dispose(expectedFacetNonce),
    abort: (reason: string) => {
      options.facets.abort(options.name, reason);
      return { requested: true, stopped: "unknown" as const };
    },
  };
}
