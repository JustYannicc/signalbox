import { createClaudeCliFacetClass } from "../../../../src/harness/ClaudeCliSession.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "../../../../src/harness/NodeNativeModules.ts";
import { createClaudePreparedImports } from "./claudePreparedImports.ts";

const imports = createClaudePreparedImports();
export const ClaudeCliFacet = createClaudeCliFacetClass((_ctx, _env, configuration) => {
  const plan = configuration.loaded.plan;
  if (plan.harness !== "claude-code") throw new Error("CLI selected another provider");
  return {
    nativeModules: DEFAULT_NODE_NATIVE_MODULES,
    loadPackages: async (_bridge, signal) => imports.loadPackages(plan, signal),
    loadRelease: async (_bridge, signal) => imports.loadRelease(plan, signal),
  };
});
