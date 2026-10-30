import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";

import { WorkOSAuthenticateError, type WorkOSConfig } from "./WorkOSClient.ts";

/** Cold email sign-in must not enter hosted AuthKit's organization picker. */
export const sendCode = Effect.fn("WorkOSMagicAuth.sendCode")(function* (
  config: WorkOSConfig & { readonly apiKey: Redacted.Redacted<string> },
  email: string,
) {
  const http = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(
    new URL("/user_management/magic_auth", config.apiBaseUrl),
  ).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
    HttpClientRequest.bodyJson({ email }),
    Effect.mapError(() => new WorkOSAuthenticateError({})),
  );
  const response = yield* http
    .execute(request)
    .pipe(Effect.mapError(() => new WorkOSAuthenticateError({})));
  if (response.status < 200 || response.status >= 300) {
    return yield* new WorkOSAuthenticateError({ status: response.status });
  }
});
