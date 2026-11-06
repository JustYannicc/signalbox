import { retainRpcCapability } from "../rpc/Capability.ts";
import { readRpcData } from "../rpc/Resources.ts";
import type { ChildProgramCodes } from "./ChildProgramCodes.ts";
import type { ChildWorkerModulesFactory } from "./ChildWorkerCode.ts";
import { createComputerProgramCatalog } from "./ComputerProgramCatalog.ts";

/** Program factories arrive as RPC arguments and remain callable for the Computer owner's life. */
export function ownComputerProgramCatalog(programs: ChildProgramCodes) {
  const capabilities: Disposable[] = [];
  const factories = new Map<ChildWorkerModulesFactory, ChildWorkerModulesFactory>();
  const dispose = () => {
    const failures: unknown[] = [];
    for (const capability of capabilities.splice(0).toReversed()) {
      try {
        capability[Symbol.dispose]();
      } catch (error) {
        failures.push(error);
      }
    }
    factories.clear();
    if (failures.length > 0)
      throw new AggregateError(failures, "Computer program sources could not close");
  };
  try {
    const catalog = createComputerProgramCatalog(programs);
    for (const [path, program] of catalog.programs) {
      const source = program.code.modules;
      if (typeof source !== "function") continue;
      let factory = factories.get(source);
      if (factory === undefined) {
        const capability = retainRpcCapability(source);
        capabilities.push(capability);
        factory = () => readRpcData(capability.value());
        factories.set(source, factory);
      }
      catalog.programs.set(path, { ...program, code: { ...program.code, modules: factory } });
    }
    factories.clear();
    return { ...catalog, [Symbol.dispose]: dispose };
  } catch (cause) {
    try {
      dispose();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], "Computer program source acquisition failed", {
        cause: cleanup,
      });
    }
    throw cause;
  }
}
