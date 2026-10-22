import * as Schema from "effect/Schema";

export const ReleaseOmissionConfiguration = Schema.Struct({
  name: Schema.String,
  env: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ReleaseOmissionConfiguration = typeof ReleaseOmissionConfiguration.Type;

export const ReleaseChunkOmittedEvent = Schema.Struct({
  code: Schema.Literal("RELEASE_CHUNK_OMITTED"),
  inputPath: Schema.String,
  tier: Schema.Literals(["configuration", "corpus"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ReleaseChunkOmittedEvent = typeof ReleaseChunkOmittedEvent.Type;

export const ReleaseChunkOmittedFailure = Schema.TaggedStruct("ReleaseChunkOmittedFailure", {
  ...ReleaseChunkOmittedEvent.fields,
  message: Schema.String,
  stack: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ReleaseChunkOmittedFailure = typeof ReleaseChunkOmittedFailure.Type;
