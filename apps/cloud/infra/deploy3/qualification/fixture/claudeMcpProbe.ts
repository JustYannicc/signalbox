import * as Schema from "effect/Schema";

export const ClaudeMcpProbe = Schema.Struct({
  toolName: Schema.String.check(Schema.isPattern(/^mcp__executor__\S+$/u)),
  input: Schema.Record(Schema.String, Schema.Json),
  expectedText: Schema.String.check(Schema.isPattern(/\S/u)),
});
export type ClaudeMcpProbe = typeof ClaudeMcpProbe.Type;
export const decodeClaudeMcpProbe = Schema.decodeUnknownSync(ClaudeMcpProbe, {
  onExcessProperty: "error",
  reportInput: false,
});
