// Keep infrastructure consumers on this module's public root while the transform stays private.
export { primordialAcorn } from "./node/vm/vendor/nimbus/worker/scripts/acorn-primordials.mjs";

export const NODE_VM_EXPRESSION_ANALYSIS_SOURCE = new URL(
  "./node/vm/prepared/expression-analysis.mjs",
  import.meta.url,
);
