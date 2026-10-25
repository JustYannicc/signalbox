import * as Schema from "effect/Schema";

export const RELEASE_MODULE_OMITTED_CODE = "RELEASE_MODULE_OMITTED";
export const RELEASE_MODULE_OMITTED_REPORTER_KEY = "signalbox.releaseModuleOmitted";

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
