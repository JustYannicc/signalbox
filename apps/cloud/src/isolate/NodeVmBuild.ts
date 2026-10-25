// Keep infrastructure consumers on this module's public root while the transform stays private.
export { primordialAcorn } from "./node/vm/vendor/nimbus/worker/scripts/acorn-primordials.mjs";
export { nimbusFunctionBuildSource } from "./node/vm/prepared/function-build-source.ts";

export const NODE_VM_EXPRESSION_ANALYSIS_SOURCE = new URL(
  "./node/vm/prepared/expression-analysis.mjs",
  import.meta.url,
);

export const NODE_VM_FUNCTION_RUNTIME_SOURCE = new URL(
  "./node/vm/vendor/nimbus/core/src/_shared/commonjs-cell.ts",
  import.meta.url,
);

export const NODE_VM_FUNCTION_PARSER_SOURCE = new URL(
  "./node/vm/prepared/function-parser.mjs",
  import.meta.url,
);
