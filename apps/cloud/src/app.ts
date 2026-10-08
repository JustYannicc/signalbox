import {
  EnvironmentAuthInvalidError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpEffect from "effect/http/HttpEffect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as CloudAccounts from "./account/CloudAccounts.ts";
import * as CloudSessions from "./auth/CloudSessions.ts";
import * as CloudTokens from "./auth/CloudTokens.ts";
import * as CloudConfig from "./CloudConfig.ts";
import * as GitHub from "./github/GitHub.ts";
import * as GitHubRoutes from "./github/githubRoutes.ts";
import * as AccountRoutes from "./http/accountRoutes.ts";
import { NO_STORE_HEADERS, requestCredentials, traceId } from "./http/credentials.ts";
import * as EnvironmentApi from "./http/environmentApi.ts";
import * as Platform from "./platform.ts";
import * as CloudThreadService from "./thread/CloudThreadService.ts";
import * as ThreadDirectory from "./thread/ThreadDirectory.ts";
import * as ThreadContexts from "./user/threadContexts.ts";
import * as UserDirectory from "./user/UserDirectory.ts";

/**
 * The cloud environment's request handling, built once per isolate: the
 * environment HTTP API, the account routes, and `/ws`, which authenticates a
 * socket and hands it to the session owner's object.
 */

/** Same request headers a self-hosted server accepts cross-origin (desktop's `signalbox://app`). */
const CORS_ALLOWED_HEADERS = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
];

const layerCors = HttpRouter.cors({
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: CORS_ALLOWED_HEADERS,
  maxAge: 600,
});

export const layerServices = (input: {
  readonly vars: Record<string, string>;
  readonly users: UserDirectory.UserObjectNamespace;
  readonly threads: ThreadDirectory.ThreadObjectNamespace;
  readonly localWorkerd: boolean;
}) =>
  Layer.mergeAll(CloudAccounts.layer, CloudThreadService.layer).pipe(
    // The Worker only reads threads; they are created in their user's object.
    Layer.provideMerge(ThreadContexts.layerWorker),
    Layer.provideMerge(CloudSessions.layer),
    Layer.provideMerge(
      GitHub.layer(GitHub.gitHubAppConfig(input.vars), GitHub.gitHubEndpoints(input.vars)),
    ),
    Layer.provideMerge(CloudTokens.layer),
    Layer.provideMerge(CloudConfig.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        UserDirectory.layerDurableObjects(input.users, { localWorkerd: input.localWorkerd }),
        ThreadDirectory.layerDurableObjects(input.threads, { localWorkerd: input.localWorkerd }),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(FetchHttpClient.layer, Platform.layerCrypto, Platform.layerHttp),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.vars }))),
  );

type Services = Layer.Success<ReturnType<typeof layerServices>>;

// Raw account routes resolve services per request, from the context the web
// handler is built with; the API groups take them when the router is built.
const routes = Layer.mergeAll(EnvironmentApi.layer, AccountRoutes.layer, GitHubRoutes.layer).pipe(
  Layer.provide(layerCors),
);

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: NO_STORE_HEADERS });

/** `/ws`: the protocol gate and authentication, exactly as a self-hosted server orders them. */
const openSocket = (request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    if (
      url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) !==
      ORCHESTRATION_PROTOCOL_VERSION_TEXT
    ) {
      return json(
        {
          code: "orchestration_protocol_incompatible",
          message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        },
        426,
      );
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const sessions = yield* CloudSessions.CloudSessions;
    const users = yield* UserDirectory.UserDirectory;
    const ticket = url.searchParams.get("wsTicket");
    // Bearer clients present a ticket; a same-origin browser presents its cookie.
    // Only the signature is checked here: the object checks the session itself.
    const claims = yield* ticket
      ? sessions.ticketClaims(ticket)
      : sessions.claims(requestCredentials(HttpServerRequest.fromWeb(request)));
    return yield* users.connect(claims, request);
  }).pipe(
    Effect.catchTags({
      CloudCredentialError: (error) =>
        traceId.pipe(
          Effect.flatMap((id) =>
            HttpServerRespondable.toResponse(
              new EnvironmentAuthInvalidError({
                code: "auth_invalid",
                reason: error.reason,
                traceId: id,
              }),
            ),
          ),
          Effect.map((response) => HttpServerResponse.toWeb(response)),
        ),
      UserObjectError: (error) =>
        Effect.logError("cloud socket upgrade failed", { cause: error }).pipe(
          Effect.as(new Response("Internal Server Error", { status: 500 })),
        ),
    }),
  );

export interface CloudApp {
  readonly http: (request: Request) => Promise<Response>;
  readonly webSocket: (request: Request) => Promise<Response>;
}

export const makeCloudApp = <E>(services: Layer.Layer<Services, E>): CloudApp => {
  const runtime = ManagedRuntime.make(services);
  // Lives as long as the isolate.
  const scope = Scope.makeUnsafe();
  const http = runtime
    .runPromise(
      Effect.gen(function* () {
        const httpEffect = yield* HttpRouter.toHttpEffect(routes);
        const context = yield* Effect.context<Services>();
        return HttpEffect.toWebHandler(
          httpEffect.pipe(
            // Handlers map expected failures to responses; anything left is a bug worth logging.
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("cloud request failed", Cause.pretty(cause)),
            ),
            Effect.provide(context),
          ),
        );
      }).pipe(Scope.provide(scope)),
    )
    .catch(async (cause: unknown) => {
      await Effect.runPromise(Scope.close(scope, Exit.die(cause)));
      throw cause;
    });
  return {
    http: (request) => http.then((handler) => handler(request)),
    webSocket: (request) => runtime.runPromise(openSocket(request)),
  };
};
