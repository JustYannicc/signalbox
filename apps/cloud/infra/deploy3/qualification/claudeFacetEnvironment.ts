import { HARNESS_C_PRODUCT_CAPABILITY_KEYS as Keys } from "../../../src/harness/HarnessCProductCapabilities.ts";
import { qualifierClaudeFacetInputs } from "./facetEnvironmentContract.ts";
import * as Schema from "effect/Schema";

const decodeCapabilities = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

export function createQualifierClaudeFacetEnvironment<
  Environment extends Readonly<Record<string, unknown>>,
  Authority,
>(
  environment: Environment,
  source: { readonly RUN_ID: string; readonly CONFIG_SHA256: string },
  variant: "baseline" | "hooks",
  authorities: {
    readonly access: Authority;
    readonly executor: Authority;
    readonly continuations: Authority;
  },
) {
  return {
    ...environment,
    ...qualifierClaudeFacetInputs(source, variant),
    CLAUDE_ACCESS: authorities.access,
    CLAUDE_EXECUTOR: authorities.executor,
    HARNESS_C_PRODUCT_CAPABILITIES: {
      ...decodeCapabilities(environment.HARNESS_C_PRODUCT_CAPABILITIES),
      [Keys.access]: authorities.access,
      [Keys.executor]: authorities.executor,
      claudeContinuationPublisher: authorities.continuations,
    },
  };
}
