import * as BunJsc from "../../src/isolate/NodeBunJsc.ts";
import { createNodeEnvironmentResolver } from "../../src/isolate/NodeEnvironment.ts";
import { createNodeModule } from "../../src/isolate/NodeModule.ts";
import type { NodeBridge } from "../../src/isolate/NodeBridge.ts";

export interface ProofPackages {
  readonly yaml: object;
  readonly undici: object;
}

export function createProofEnvironment(options: {
  readonly bridge: () => NodeBridge;
  readonly loadPackages: () => Promise<ProofPackages>;
  readonly onBuiltinFailure: (specifier: string) => void;
}) {
  let resolver = createNodeEnvironmentResolver({ packages: { "bun:jsc": BunJsc }, addons: [] });
  const module = createNodeModule(
    {
      require(specifier) {
        try {
          return options.bridge().require(specifier);
        } catch (error) {
          options.onBuiltinFailure(specifier);
          throw error;
        }
      },
    },
    (specifier, referrer) => resolver(specifier, referrer),
  );
  return {
    module,
    async load() {
      const packages = await options.loadPackages();
      // The resolver checks actual root exports instead of manufacturing package namespaces.
      resolver = createNodeEnvironmentResolver({
        packages: { ...packages, "bun:jsc": BunJsc },
        addons: [],
      });
      return { packages: Object.keys(packages).sort(), bunJsc: Object.keys(BunJsc).sort() };
    },
  };
}
