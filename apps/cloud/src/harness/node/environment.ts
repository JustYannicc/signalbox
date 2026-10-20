import * as BunJsc from "../../isolate/NodeBunJsc.ts";
import { createNodeEnvironmentResolver } from "../../isolate/NodeEnvironment.ts";
import { createNodeModule } from "../../isolate/NodeModule.ts";
import type { NodeBridge } from "../../isolate/NodeBridge.ts";
import type { NodeHarnessProcessInput } from "./types.ts";

export function createHarnessEnvironment(input: NodeHarnessProcessInput, bridge: () => NodeBridge) {
  const shared = {
    addons: input.addons ?? [],
    ...(input.prepared === undefined ? {} : { prepared: input.prepared }),
  };
  let resolver = createNodeEnvironmentResolver({ ...shared, packages: { "bun:jsc": BunJsc } });
  const module = createNodeModule(
    { require: (specifier) => bridge().require(specifier) },
    (specifier, referrer) => resolver(specifier, referrer),
    input.resolvePrepared,
  );
  return {
    module,
    async load(signal: AbortSignal) {
      const packages = await input.loadPackages(bridge(), signal);
      signal.throwIfAborted();
      resolver = createNodeEnvironmentResolver({
        ...shared,
        packages: { "bun:jsc": BunJsc, ...packages },
      });
    },
  };
}
