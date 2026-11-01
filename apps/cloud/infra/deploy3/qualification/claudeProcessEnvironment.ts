import * as Schema from "effect/Schema";

const ProcessEnvironment = Schema.Struct({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: Schema.Literal("1"),
  DISABLE_TELEMETRY: Schema.Literal("1"),
  DISABLE_AUTOUPDATER: Schema.Literal("1"),
  DISABLE_ERROR_REPORTING: Schema.Literal("1"),
  API_TIMEOUT_MS: Schema.Literal("5460000"),
  CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: Schema.Literal("5460000"),
  HTTP_PROXY: Schema.Literal(""),
  HTTPS_PROXY: Schema.Literal(""),
  ALL_PROXY: Schema.Literal(""),
  http_proxy: Schema.Literal(""),
  https_proxy: Schema.Literal(""),
  all_proxy: Schema.Literal(""),
  NO_PROXY: Schema.Literal("*"),
  no_proxy: Schema.Literal("*"),
});

export const QualifierClaudeProcessEnvironment = Schema.Record(Schema.String, Schema.Unknown)
  .check(Schema.isPropertyNames(Schema.Literals(Object.keys(ProcessEnvironment.fields))))
  .pipe(Schema.decodeTo(ProcessEnvironment));

/** Match the recorded local host's operating controls without replacing fixture routing or auth. */
export const qualifierClaudeProcessEnvironment = () =>
  ({
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    API_TIMEOUT_MS: "5460000",
    CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "5460000",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "*",
    no_proxy: "*",
  }) satisfies typeof QualifierClaudeProcessEnvironment.Type;
