import {
  AuthAccessReadScope,
  AuthAccessTokenType,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudConfig from "../CloudConfig.ts";
import * as Environment from "../environment.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { NO_STORE_HEADERS, requestCredentials, sessionCookie, traceId } from "./credentials.ts";

/**
 * The environment HTTP API, served from the contract's own groups so paths,
 * payloads, status codes and error bodies match a self-hosted server exactly.
 * Handlers decode, call one service, and map errors.
 */

const CloudHttpApi = HttpApi.make("cloud")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.orchestration);

const appendNoStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, NO_STORE_HEADERS)),
);

const authInvalid = (reason: CloudSessions.CloudCredentialError["reason"]) =>
  Effect.flatMap(traceId, (id) =>
    Effect.fail(new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId: id })),
  );

const internal = (reason: EnvironmentInternalErrorReason, cause: unknown) =>
  Effect.logError("cloud environment request failed", { reason, cause }).pipe(
    Effect.andThen(traceId),
    Effect.flatMap((id) =>
      Effect.fail(new EnvironmentInternalError({ code: "internal_error", reason, traceId: id })),
    ),
  );

const requireScope = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const principal = yield* EnvironmentAuthenticatedPrincipal;
    if (principal.scopes.has(scope)) return principal;
    return yield* new EnvironmentScopeRequiredError({
      code: "insufficient_scope",
      requiredScope: scope,
      traceId: yield* traceId,
    });
  });

const userIdOf = (principal: EnvironmentSessionPrincipalShape) =>
  principal.subject.slice(CloudSessions.ACCOUNT_SUBJECT_PREFIX.length);

const toPrincipal = (session: CloudSessions.CloudSession): EnvironmentSessionPrincipalShape => ({
  sessionId: session.sessionId,
  subject: `${CloudSessions.ACCOUNT_SUBJECT_PREFIX}${session.userId}`,
  method: session.method,
  scopes: new Set(session.scopes),
  expiresAt: DateTime.makeUnsafe(session.expiresAt),
});

const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const sessions = yield* CloudSessions.CloudSessions;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* sessions.authenticate(requestCredentials(request)).pipe(
          Effect.catchTags({
            CloudCredentialError: (error) => authInvalid(error.reason),
            UserObjectError: (error) => internal("internal_error", error),
          }),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, toPrincipal(session)),
        );
      });
  }),
);

const layerMetadata = HttpApiBuilder.group(
  CloudHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* CloudConfig.CloudConfig;
    return handlers.handle("descriptor", () => Effect.succeed(Environment.descriptor(config)));
  }),
);

/** Access management (devices, pairing links) is not served yet; no cloud session holds its scopes. */
const accessManagement = (scope: AuthEnvironmentScope) => () =>
  requireScope(scope).pipe(
    Effect.andThen(Effect.die("unreachable: cloud sessions lack access scopes")),
  );

const layerAuth = HttpApiBuilder.group(
  CloudHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* CloudSessions.CloudSessions;

    const setSessionCookie = (token: string, expiresAt: number) =>
      Effect.gen(function* () {
        const cookies = yield* sessionCookie(token, expiresAt).pipe(
          Effect.catch((error) => internal("browser_session_cookie_failed", error)),
        );
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
        );
      });

    return handlers
      .handle("session", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* sessions
            .authenticate(requestCredentials(request))
            .pipe(Effect.catchTags({ CloudCredentialError: () => Effect.succeed(null) }));
          if (!session) return { authenticated: false, auth: Environment.authDescriptor };
          return {
            authenticated: true,
            auth: Environment.authDescriptor,
            scopes: session.scopes,
            sessionMethod: session.method,
            expiresAt: DateTime.makeUnsafe(session.expiresAt),
          };
        }).pipe(
          Effect.catchTags({ UserObjectError: (error) => internal("internal_error", error) }),
        ),
      )
      .handle("browserSession", ({ payload }) =>
        Effect.gen(function* () {
          const { session, token } = yield* sessions.exchangeCredential(payload.credential, {
            method: "browser-session-cookie",
            scopes: CloudSessions.CLOUD_SESSION_SCOPES,
          });
          yield* setSessionCookie(token, session.expiresAt);
          yield* appendNoStore;
          return {
            authenticated: true as const,
            scopes: session.scopes,
            sessionMethod: session.method,
            expiresAt: DateTime.makeUnsafe(session.expiresAt),
          };
        }).pipe(
          Effect.catchTags({
            CloudCredentialError: (error) => authInvalid(error.reason),
            UserObjectError: (error) => internal("browser_session_issuance_failed", error),
          }),
        ),
      )
      .handle("token", ({ payload }) =>
        Effect.gen(function* () {
          // A credential grants the standard scopes; a request may narrow them, never widen.
          const requested =
            payload.scope === undefined
              ? CloudSessions.CLOUD_SESSION_SCOPES
              : parseAllowedOAuthScope({
                  value: payload.scope,
                  allowedScopes: new Set(CloudSessions.CLOUD_SESSION_SCOPES),
                });
          if (requested === null) {
            return yield* new EnvironmentRequestInvalidError({
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: yield* traceId,
            });
          }
          const { session, token } = yield* sessions.exchangeCredential(payload.subject_token, {
            method: "bearer-access-token",
            scopes: [...requested],
            ...(payload.client_label ? { label: payload.client_label } : {}),
          });
          yield* appendNoStore;
          return {
            access_token: token,
            issued_token_type: AuthAccessTokenType,
            token_type: "Bearer" as const,
            expires_in: Math.floor((session.expiresAt - (yield* Clock.currentTimeMillis)) / 1000),
            scope: session.scopes.join(" "),
          };
        }).pipe(
          Effect.catchTags({
            CloudCredentialError: (error) => authInvalid(error.reason),
            UserObjectError: (error) => internal("access_token_issuance_failed", error),
          }),
        ),
      )
      .handle("webSocketTicket", () =>
        Effect.gen(function* () {
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const { ticket, expiresAt } = yield* sessions.issueTicket({
            userId: userIdOf(principal),
            sessionId: principal.sessionId,
            expiresAt: principal.expiresAt
              ? DateTime.toEpochMillis(principal.expiresAt)
              : Number.MAX_SAFE_INTEGER,
          });
          yield* appendNoStore;
          return { ticket, expiresAt: DateTime.makeUnsafe(expiresAt) };
        }),
      )
      .handle("pairingCredential", accessManagement(AuthAccessWriteScope))
      .handle("pairingLinks", accessManagement(AuthAccessReadScope))
      .handle("revokePairingLink", accessManagement(AuthAccessWriteScope))
      .handle("clients", accessManagement(AuthAccessReadScope))
      .handle("revokeClient", accessManagement(AuthAccessWriteScope))
      .handle("revokeOtherClients", accessManagement(AuthAccessWriteScope));
  }),
);

const layerOrchestration = HttpApiBuilder.group(
  CloudHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const users = yield* UserDirectory.UserDirectory;
    // No threads exist in the cloud yet, so every thread read is a miss.
    const threadNotFound = () =>
      requireScope(AuthOrchestrationReadScope).pipe(
        Effect.andThen(traceId),
        Effect.flatMap((id) =>
          Effect.fail(
            new EnvironmentResourceNotFoundError({
              code: "not_found",
              reason: "thread_not_found",
              traceId: id,
            }),
          ),
        ),
      );
    return handlers
      .handle("shellSnapshot", () =>
        requireScope(AuthOrchestrationReadScope).pipe(
          Effect.flatMap((principal) => users.forUser(userIdOf(principal)).shellSnapshot()),
          Effect.catchTags({
            UserObjectError: (error) => internal("orchestration_snapshot_failed", error),
          }),
        ),
      )
      .handle("threadSnapshot", threadNotFound)
      .handle("threadBoundedSnapshot", threadNotFound)
      .handle("threadHistoryPage", threadNotFound);
  }),
);

/** Every environment API group; needs the cloud services and an auth middleware. */
export const layer = HttpApiBuilder.layer(CloudHttpApi).pipe(
  Layer.provide([layerMetadata, layerAuth, layerOrchestration]),
  Layer.provide(layerAuthenticatedAuth),
);
