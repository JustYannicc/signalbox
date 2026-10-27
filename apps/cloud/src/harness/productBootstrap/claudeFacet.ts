import { createHarnessRequestFacetClass } from "../HarnessRequestFacetObject.ts";
import {
  createProductClaudeHarnessSessionHost,
  type ProductClaudeHarnessHostOptions,
  type ProductClaudeHarnessSessionHost,
} from "../ProductClaudeHarnessSessionHost.ts";
import { composeHarnessCProductFacetOptions } from "./facet.ts";
import type {
  HarnessCProductFacetEnvironment,
  HarnessCProductFacetFactory,
} from "./facetContracts.ts";

/** Claude's module graph contains no Codex native adapter imports. */
export function createHarnessCProductClaudeFacetClass<
  Env extends HarnessCProductFacetEnvironment,
  G,
>(
  dependencies: Omit<
    HarnessCProductFacetFactory<
      Env,
      G,
      ProductClaudeHarnessHostOptions<G>["native"],
      ProductClaudeHarnessHostOptions<G>,
      ProductClaudeHarnessSessionHost<G>
    >,
    "provider" | "createHost"
  >,
) {
  return createHarnessRequestFacetClass<Env>((input) =>
    composeHarnessCProductFacetOptions(input, {
      ...dependencies,
      provider: "claude-code",
      createHost: createProductClaudeHarnessSessionHost,
    }),
  );
}
