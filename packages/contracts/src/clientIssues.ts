import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

export const CLIENT_ISSUES_PATH = "/api/observability/client-issues";

// Codes are reviewed metadata. A string pattern would also admit private text.
export const CLIENT_ISSUE_CODES = [
  "rpc.failed",
  "rpc.timed_out",
  "subscription.failed",
  "subscription.timed_out",
  "runtime.uncaught",
  "runtime.unhandled_rejection",
  "runtime.boot_failed",
  "react.boundary",
  "react.route",
  "console.error",
  "console.warn",
  "toast.error",
  "toast.warning",
  "provider.status",
  "connection.status",
  "pool.status",
] as const;
export const ClientIssueCode = Schema.Literals(CLIENT_ISSUE_CODES);
export type ClientIssueCode = typeof ClientIssueCode.Type;

const ContextId = Schema.NullOr(
  Schema.String.check(
    Schema.isPattern(
      /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|(?:user|org)_[0-9A-HJKMNP-TV-Z]{26})$/,
    ),
  ),
);
const hexId = (length: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^(?!0{${length}}$)[a-f0-9]{${length}}$`)));

export const ClientIssue = Schema.Struct({
  code: ClientIssueCode,
  severity: Schema.Literals(["error", "warning"]),
  source: Schema.Literals(["ui", "rpc", "subscription", "exception", "console", "react"]),
  client: Schema.Literals(["web", "desktop", "mobile"]),
  release: Schema.String.check(
    Schema.isPattern(
      /^(?:[a-f0-9]{7,40}|\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z]+\.\d{1,8})?|development|unknown)$/,
    ),
  ),
  threadId: ContextId,
  folderId: ContextId,
  // The receiver replaces this with its own deployment identity.
  environmentId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  traceId: hexId(32),
  spanId: hexId(16),
  method: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
  durationMs: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 86_400_000 })),
  ),
});
export type ClientIssue = typeof ClientIssue.Type;

const Rejected = Schema.Struct({
  code: Schema.Literal("client_issue_rejected"),
  traceId: Schema.String,
});

export class ClientIssuesHttpApi extends HttpApiGroup.make("clientIssues").add(
  HttpApiEndpoint.post("report", CLIENT_ISSUES_PATH, {
    headers: Schema.Struct({
      authorization: Schema.optionalKey(Schema.String),
      dpop: Schema.optionalKey(Schema.String),
      traceparent: Schema.optionalKey(Schema.String),
    }),
    payload: ClientIssue,
    success: HttpApiSchema.NoContent,
    error: [400, 401, 403, 408, 413, 415, 429, 503].map((status) =>
      Rejected.pipe(HttpApiSchema.status(status)),
    ),
  }),
) {}
