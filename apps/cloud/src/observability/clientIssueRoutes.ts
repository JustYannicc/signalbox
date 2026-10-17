import { CLIENT_ISSUES_PATH } from "@t3tools/contracts/clientIssues";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { failure, NO_STORE_HEADERS, requestCredentials } from "../http/credentials.ts";
import * as ClientIssueIntake from "./ClientIssueIntake.ts";

export const layer = HttpRouter.add(
  "POST",
  CLIENT_ISSUES_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const intake = yield* ClientIssueIntake.ClientIssueIntake;
    yield* intake.ingest({
      credentials: requestCredentials(request),
      contentType: request.headers["content-type"],
      contentEncoding: request.headers["content-encoding"],
      contentLength: request.headers["content-length"],
      traceparent: request.headers.traceparent,
      body: request.stream,
    });
    return HttpServerResponse.empty({ status: 204, headers: NO_STORE_HEADERS });
  }).pipe(
    Effect.catchTags({
      CloudCredentialError: () => failure("client_issue_rejected", 401),
      ClientIssueRejected: ({ status }) => failure("client_issue_rejected", status),
    }),
  ),
);
