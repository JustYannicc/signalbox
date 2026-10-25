import { CLIENT_TRACES_PATH } from "@t3tools/shared/clientTraceSafety";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { failure, json, requestCredentials } from "../http/credentials.ts";
import * as ClientTraceIntake from "./ClientTraceIntake.ts";

export const layer = HttpRouter.add(
  "POST",
  CLIENT_TRACES_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const intake = yield* ClientTraceIntake.ClientTraceIntake;
    yield* intake.ingest({
      credentials: requestCredentials(request),
      contentType: request.headers["content-type"],
      contentEncoding: request.headers["content-encoding"],
      contentLength: request.headers["content-length"],
      body: request.stream,
    });
    return json({}, 200);
  }).pipe(
    Effect.catchTags({
      CloudCredentialError: () => failure("auth_invalid", 401),
      ClientTraceRejected: ({ status }) => failure("trace_intake_rejected", status),
    }),
  ),
);
