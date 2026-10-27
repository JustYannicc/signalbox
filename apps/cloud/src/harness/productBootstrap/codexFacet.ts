import { createHarnessRequestFacetClass } from "../HarnessRequestFacetObject.ts";
import {
  createProductCodexHarnessSessionHost,
  type ProductCodexHarnessHostOptions,
  type ProductCodexHarnessSessionHost,
} from "../ProductCodexHarnessSessionHost.ts";
import { composeHarnessCProductFacetOptions } from "./facet.ts";
import type {
  HarnessCProductFacetEnvironment,
  HarnessCProductFacetFactory,
} from "./facetContracts.ts";

/** Codex's module graph contains no Claude native adapter imports. */
export function createHarnessCProductCodexFacetClass<
  Env extends HarnessCProductFacetEnvironment,
  G,
>(
  dependencies: Omit<
    HarnessCProductFacetFactory<
      Env,
      G,
      ProductCodexHarnessHostOptions<G>["native"],
      ProductCodexHarnessHostOptions<G>,
      ProductCodexHarnessSessionHost<G>
    >,
    "provider" | "createHost"
  >,
) {
  return createHarnessRequestFacetClass<Env>((input) =>
    composeHarnessCProductFacetOptions(input, {
      ...dependencies,
      provider: "codex",
      createHost: createProductCodexHarnessSessionHost,
    }),
  );
}
