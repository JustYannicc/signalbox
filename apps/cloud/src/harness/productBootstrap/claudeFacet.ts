import { createHarnessRequestFacetClass } from "../HarnessRequestFacetObject.ts";
import {
  createProductClaudeKernelHost,
  type ProductClaudeKernelHostOptions,
  type ProductClaudeKernelHost,
} from "../ProductClaudeKernelHost.ts";
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
      ProductClaudeKernelHostOptions<G>["native"],
      ProductClaudeKernelHostOptions<G>,
      ProductClaudeKernelHost<G>
    >,
    "provider" | "createHost"
  >,
) {
  return createHarnessRequestFacetClass<Env>((input) =>
    composeHarnessCProductFacetOptions(input, {
      ...dependencies,
      provider: "claude-code",
      createHost: createProductClaudeKernelHost,
    }),
  );
}
