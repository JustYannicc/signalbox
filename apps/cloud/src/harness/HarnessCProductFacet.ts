export { composeHarnessCProductFacetOptions } from "./productBootstrap/facet.ts";
export { prepareHarnessCProductHost } from "./productBootstrap/prepareProductHost.ts";
export { prepareFreshHarnessCProductHost } from "./productBootstrap/prepareFreshProductHost.ts";
export type {
  HarnessCProductFacetEnvironment,
  HarnessCProductFacetFactory,
  HarnessCProductFreshHostPreparationInput,
  HarnessCProductInitialCheckpointContext,
  HarnessCProductInitialCheckpointResult,
  HarnessCProductTurnBindings,
  PreparedFreshHarnessCProductHost,
} from "./productBootstrap/facetContracts.ts";
export type { ProductHostOptions, ProductHarnessSessionHost } from "./host/product.ts";
