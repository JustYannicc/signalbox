import {
  createHarnessCProductClaudeFacetClass,
  type HarnessCProductFacetEnvironment,
  type HarnessCProductFacetFactory,
} from "../../../src/harness/ProductClaudeHarnessRequestFacet.ts";
import type {
  ProductClaudeHarnessHostOptions,
  ProductClaudeHarnessSessionHost,
} from "../../../src/harness/ProductClaudeHarnessSessionHost.ts";
import { runClaudeQualificationPublicTurn } from "./publicTurn.ts";
import type { ClaudeQualificationPublicTurnInput } from "./publicTurn.ts";

/** Builds the same public Claude facet class used by product C; no proof-local host is substituted. */
export function createClaudeQualificationFacetClass<Env extends HarnessCProductFacetEnvironment, G>(
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
  return createHarnessCProductClaudeFacetClass<Env, G>(dependencies);
}

/** Calls the public facet's first run RPC; the parent supplies the staged text/tool request. */
export function runClaudeQualificationWorkerScenario(input: ClaudeQualificationPublicTurnInput) {
  return runClaudeQualificationPublicTurn(input);
}
