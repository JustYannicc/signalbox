import * as Schema from "effect/Schema";
import {
  QualifierClaudeInputs,
  QualifierClaudeFacetConfiguration,
  assertQualifierClaudeFacetConfiguration as assertQualifierClaudeNativeFacetConfiguration,
} from "./facetEnvironmentContract.ts";

const nativeFields = QualifierClaudeFacetConfiguration.fields;
export const QualifierClaudeCalibrationFacetConfiguration = Schema.Struct({
  ...QualifierClaudeInputs.fields,
  QUALIFIER_CLAUDE_FACET_MODE: Schema.Literal("inert-import-calibration"),
  HARNESS_PROCESS_ID: nativeFields.HARNESS_PROCESS_ID,
  HARNESS_PROCESS_SHARD_OWNER: nativeFields.HARNESS_PROCESS_SHARD_OWNER,
  HARNESS_PROCESS_LOADER_ID: nativeFields.HARNESS_PROCESS_LOADER_ID,
  HARNESS_PROCESS_FACET_KEY: nativeFields.HARNESS_PROCESS_FACET_KEY,
  HARNESS_C_PRODUCT_BOOTSTRAP: nativeFields.HARNESS_C_PRODUCT_BOOTSTRAP,
  HARNESS_C_TARGET_PREPARED_RELEASE: nativeFields.HARNESS_C_TARGET_PREPARED_RELEASE,
  HARNESS_C_PRODUCT_CAPABILITIES: nativeFields.HARNESS_C_PRODUCT_CAPABILITIES,
  CLAUDE_ACCESS: nativeFields.CLAUDE_ACCESS,
  CLAUDE_EXECUTOR: nativeFields.CLAUDE_EXECUTOR,
  PROGRAM_ASSETS: nativeFields.PROGRAM_ASSETS,
  HARNESS_RESUME_RUN_ID: Schema.optionalKey(Schema.Never),
  HARNESS_RESUME_CONTROL: Schema.optionalKey(Schema.Never),
  HARNESS_RESUME_CREATION: Schema.optionalKey(Schema.Never),
  HARNESS_RESUME_PUBLISHER: Schema.optionalKey(Schema.Never),
  HARNESS_RESUME_RUN_STORE: Schema.optionalKey(Schema.Never),
  HARNESS_RESUME_FILES_STORE: Schema.optionalKey(Schema.Never),
  HARNESS_RESUME_SUPERVISOR: Schema.optionalKey(Schema.Never),
  HARNESS_REQUEST_PUBLISHER: Schema.optionalKey(Schema.Never),
});
export const assertQualifierClaudeCalibrationFacetConfiguration = Schema.decodeUnknownSync(
  QualifierClaudeCalibrationFacetConfiguration,
);

export function assertQualifierClaudeFacetConfiguration(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "QUALIFIER_CLAUDE_FACET_MODE")
  )
    return assertQualifierClaudeCalibrationFacetConfiguration(input);
  return assertQualifierClaudeNativeFacetConfiguration(input);
}
