import { disposeWorkerLoaderStubs } from "../../../../src/computer/WorkerLoaderResources.ts";
import type { ClaudeKernelFacet } from "./claudeKernelFacet.ts";
import type { QualifierClaudeKernelPort } from "./claudeKernelProtocol.ts";
import type { ComputerExecutionObject } from "../../../../src/computer/ComputerExecutionObject.ts";
import type { ComputerExecutionConfiguration } from "../../../../src/computer/ComputerExecutionObject.ts";
import type { ComputerProgramOwnerPort } from "../../../../src/kernel/KernelComputerAdmissionPort.ts";

interface Owners {
  kernel(code: WorkerLoaderWorkerCode): QualifierClaudeKernelPort;
  computer(
    code: WorkerLoaderWorkerCode,
  ): ComputerProgramOwnerPort & { configure(input: ComputerExecutionConfiguration): Promise<void> };
}

/** The same parent handle releases the host and both sibling owners on every teardown path. */
export function ownedClaudeFacetWorker(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  name: string,
  prepare: (owners: Owners) => Promise<WorkerLoaderWorkerCode>,
) {
  let closed = false;
  const children: {
    readonly key: string;
    readonly worker: WorkerStub;
    readonly facetClass: unknown;
    readonly stub: unknown;
  }[] = [];
  function open<T extends Rpc.DurableObjectBranded>(
    role: string,
    entrypoint: string,
    code: WorkerLoaderWorkerCode,
  ) {
    if (closed) throw new Error("Claude owner construction was retired");
    const key = `${name}:${role}`;
    const worker = loader.get(key, () => code);
    let facetClass: ReturnType<typeof worker.getDurableObjectClass<T>> | undefined;
    try {
      const currentClass = worker.getDurableObjectClass<T>(entrypoint);
      facetClass = currentClass;
      const stub = ctx.facets.get<T>(key, () => ({ class: currentClass }));
      children.push({ key, worker, facetClass, stub });
      return stub;
    } catch (error) {
      disposeWorkerLoaderStubs(facetClass, worker);
      throw error;
    }
  }
  const worker = loader.get(name, () =>
    prepare({
      kernel: (code) =>
        open<ClaudeKernelFacet>(
          "kernel",
          "ClaudeKernelFacet",
          code,
        ) as unknown as QualifierClaudeKernelPort,
      computer: (code) =>
        open<ComputerExecutionObject>(
          "computer",
          "ComputerExecutionObject",
          code,
        ) as unknown as ReturnType<Owners["computer"]>,
    }),
  );
  const owned = {
    getEntrypoint: worker.getEntrypoint.bind(worker),
    getDurableObjectClass: worker.getDurableObjectClass.bind(worker),
    [Symbol.dispose]() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      for (const child of children.toReversed()) {
        try {
          ctx.facets.abort(child.key, "Claude product owner was retired");
        } catch (error) {
          failures.push(error);
        }
        try {
          ctx.facets.delete(child.key);
        } catch (error) {
          failures.push(error);
        }
        try {
          disposeWorkerLoaderStubs(child.stub, child.facetClass, child.worker);
        } catch (error) {
          failures.push(error);
        }
      }
      children.length = 0;
      try {
        disposeWorkerLoaderStubs(worker);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Claude owner facets could not be retired");
    },
  };
  return owned;
}
