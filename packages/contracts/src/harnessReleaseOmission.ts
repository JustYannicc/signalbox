import * as Schema from "effect/Schema";

import { RELEASE_MODULE_OMITTED_CODE } from "./harnessReleaseKeys.ts";
export {
  RELEASE_MODULE_OMITTED_CODE,
  RELEASE_MODULE_OMITTED_REPORTER_KEY,
  CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY,
} from "./harnessReleaseKeys.ts";

export const ReleaseOmissionConfiguration = Schema.Struct({
  name: Schema.Literals(["product", "qualification"]),
  env: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ReleaseOmissionConfiguration = typeof ReleaseOmissionConfiguration.Type;

export const ReleaseModuleOmittedEvent = Schema.Struct({
  code: Schema.Literal(RELEASE_MODULE_OMITTED_CODE),
  inputPath: Schema.String,
  tier: Schema.Literals(["configuration", "corpus"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ReleaseModuleOmittedEvent = typeof ReleaseModuleOmittedEvent.Type;

export const ReleaseModuleOmittedFailure = Schema.TaggedStruct("ReleaseModuleOmittedFailure", {
  ...ReleaseModuleOmittedEvent.fields,
  message: Schema.String,
  stack: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ReleaseModuleOmittedFailure = typeof ReleaseModuleOmittedFailure.Type;
