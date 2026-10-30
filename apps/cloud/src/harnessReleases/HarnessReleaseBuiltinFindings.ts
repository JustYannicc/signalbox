import * as Schema from "effect/Schema";

const Record = Schema.Record(Schema.String, Schema.Unknown);
const Strings = Schema.Array(Schema.String);

/** Diagnostic records stay open until the qualification corpus establishes their disposition. */
export const HarnessReleaseBuiltinFindings = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("open"),
  sources: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      bytes: Schema.Int,
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      sourceUtf16Length: Schema.Int,
    }),
  ),
  missingBuiltins: Strings,
  unknownBuiltinSpecifiers: Strings,
  importAmbiguities: Schema.Array(Record),
  calls: Schema.Array(Record),
  callAmbiguities: Schema.Array(Record),
});
export type HarnessReleaseBuiltinFindings = typeof HarnessReleaseBuiltinFindings.Type;
export const decodeHarnessReleaseBuiltinFindings = Schema.decodeUnknownSync(
  HarnessReleaseBuiltinFindings,
  {
    onExcessProperty: "error",
    reportInput: false,
  },
);
