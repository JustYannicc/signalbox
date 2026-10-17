import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as ClientIssueContract from "@t3tools/contracts/clientIssues";
import * as ByteSize from "effect/ByteSize";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClientIssues from "./ClientIssues.ts";

export const CLIENT_ISSUE_MAX_BODY_BYTES = 8 * 1024;
const CLIENT_ISSUE_BODY_TIMEOUT = "5 seconds";

const decodeIssue = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ClientIssueContract.ClientIssue),
);

const traceparentIds = (header: string | undefined) => {
  if (header === undefined) return { _tag: "Absent" as const };
  const match = /^00-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i.exec(header);
  const traceId = match?.[1]?.toLowerCase();
  const spanId = match?.[2]?.toLowerCase();
  if (
    traceId === undefined ||
    spanId === undefined ||
    /^0+$/.test(traceId) ||
    /^0+$/.test(spanId)
  ) {
    return { _tag: "Invalid" as const };
  }
  return { _tag: "Valid" as const, traceId, spanId };
};

const rejected = (status: number, traceId: string) =>
  HttpServerResponse.jsonUnsafe({ code: "client_issue_rejected", status, traceId }, { status });

const isJsonContentType = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";

const bodyFor = (request: HttpServerRequest.HttpServerRequest) => {
  const contentEncoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    return Effect.succeed({ _tag: "UnsupportedEncoding" as const });
  }

  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > CLIENT_ISSUE_MAX_BODY_BYTES) {
      return Effect.succeed({ _tag: "TooLarge" as const });
    }
  }
  return request.arrayBuffer.pipe(
    Effect.map((buffer) => ({ _tag: "Read" as const, body: new Uint8Array(buffer) })),
    Effect.provideService(
      HttpIncomingMessage.MaxBodySize,
      ByteSize.bytes(CLIENT_ISSUE_MAX_BODY_BYTES),
    ),
    Effect.option,
    Effect.map((result) => (result._tag === "Some" ? result.value : { _tag: "TooLarge" as const })),
    Effect.timeoutOption(CLIENT_ISSUE_BODY_TIMEOUT),
    Effect.map((result) => (result._tag === "Some" ? result.value : { _tag: "TimedOut" as const })),
  );
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "clientIssues",
  Effect.fnUntraced(function* (handlers) {
    const issues = yield* ClientIssues.ClientIssues;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const crypto = yield* Crypto.Crypto;

    return handlers.handleRaw("report", ({ request }) =>
      Effect.gen(function* () {
        const traceparent = traceparentIds(request.headers["traceparent"]);
        const fallbackTraceId =
          (traceparent._tag === "Valid" ? traceparent.traceId : undefined) ??
          (yield* crypto.randomUUIDv4().pipe(Effect.orElseSucceed(() => "unknown"))).replaceAll(
            "-",
            "",
          );
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
          }),
        );
        if (session._tag === "Failure") {
          if (EnvironmentAuth.isServerAuthCredentialError(session.error)) {
            if (request.headers.authorization?.startsWith("DPoP ") === true) {
              yield* HttpEffect.appendPreResponseHandler((_request, response) =>
                Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
              );
            }
            return rejected(401, fallbackTraceId);
          }
          return rejected(503, fallbackTraceId);
        }

        const authenticatedSession = session.value;
        if (!authenticatedSession.scopes.includes(AuthOrchestrationReadScope)) {
          return rejected(403, fallbackTraceId);
        }
        if (traceparent._tag === "Invalid") return rejected(400, fallbackTraceId);
        if (!isJsonContentType(request)) return rejected(415, fallbackTraceId);

        const bodyResult = yield* bodyFor(request);
        if (bodyResult._tag === "UnsupportedEncoding") return rejected(415, fallbackTraceId);
        if (bodyResult._tag === "TimedOut") return rejected(408, fallbackTraceId);
        if (
          bodyResult._tag === "TooLarge" ||
          bodyResult.body.byteLength > CLIENT_ISSUE_MAX_BODY_BYTES
        ) {
          return rejected(413, fallbackTraceId);
        }

        const issue = yield* decodeIssue(new TextDecoder().decode(bodyResult.body)).pipe(
          Effect.option,
        );
        if (issue._tag === "None") return rejected(400, fallbackTraceId);
        if (
          traceparent._tag === "Valid" &&
          (issue.value.traceId !== traceparent.traceId || issue.value.spanId !== traceparent.spanId)
        ) {
          return rejected(400, traceparent.traceId);
        }

        return yield* issues
          .report({ issue: issue.value, sessionId: authenticatedSession.sessionId })
          .pipe(
            Effect.as(HttpServerResponse.empty({ status: 204 })),
            Effect.catchTags({
              ClientIssuePayloadError: () => Effect.succeed(rejected(400, issue.value.traceId)),
              ClientIssueRateLimitedError: () => Effect.succeed(rejected(429, issue.value.traceId)),
              ClientIssuePersistenceError: () => Effect.succeed(rejected(503, issue.value.traceId)),
            }),
          );
      }),
    );
  }),
);
