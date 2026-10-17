import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import type { ClientIssue } from "@t3tools/contracts/clientIssues";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

/** Uses the destination's cookie, bearer or renewable DPoP credentials. */
export const sendClientIssue = Effect.fnUntraced(function* (
  prepared: PreparedConnection,
  issue: ClientIssue,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    group: "clientIssues",
    method: "POST",
    url: (urls) => urls.report(),
    timeoutMs: 6_000,
    request: ({ client, headers }) =>
      client
        .report({
          payload: issue,
          headers: { ...headers, traceparent: `00-${issue.traceId}-${issue.spanId}-01` },
        })
        .pipe(
          Effect.mapError((error) => mapUnauthorizedIssueRequest(error, issue.traceId)),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        ),
  });
});

function mapUnauthorizedIssueRequest<E>(
  error: E,
  traceId: string,
): E | EnvironmentAuthInvalidError {
  // The generated endpoint declares its own 401 rejection body, but the shared
  // auth middleware may answer with the common auth body before that handler.
  if (
    HttpClientError.isHttpClientError(error) &&
    "response" in error &&
    error.response?.status === 401
  ) {
    return new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId,
    });
  }
  return error;
}
