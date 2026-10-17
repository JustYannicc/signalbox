import {
  EnvironmentAuthInvalidError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
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

import * as ClientTraceExport from "./observability/ClientTraceExport.ts";
import * as ClientTraceLimits from "./observability/ClientTraceLimits.ts";
import * as ClientTraceIntake from "./observability/ClientTraceIntake.ts";
import * as ClientTraceRoutes from "./observability/clientTraceRoutes.ts";
import { logRequestFailure } from "./observability/requestFailures.ts";
import * as CloudAccounts from "./account/CloudAccounts.ts";
import * as IdentityProvider from "./account/IdentityProvider.ts";
import * as TestIdentities from "./testSignIn/TestIdentities.ts";
import * as TestSignIn from "./testSignIn/TestSignIn.ts";
import * as TestSignInPolicy from "./testSignIn/TestSignInPolicy.ts";
import * as TestSignInRoutes from "./http/testSignInRoutes.ts";
import * as AssetRoutes from "./assets/assetRoutes.ts";
import * as CloudAssets from "./assets/CloudAssets.ts";
import * as AttachmentRoutes from "./attachments/attachmentRoutes.ts";
import type { AttachmentStorage } from "./attachments/attachmentObjects.ts";
import * as CloudAttachments from "./attachments/CloudAttachments.ts";
import * as CloudSessions from "./auth/CloudSessions.ts";
import * as CloudTokens from "./auth/CloudTokens.ts";
import * as CloudConfig from "./CloudConfig.ts";
import * as GitHub from "./github/GitHub.ts";
import * as GitHubRoutes from "./github/githubRoutes.ts";
import * as ConnectionRoutes from "./connections/connectionRoutes.ts";
import { verifyLocalKey } from "./localKeys/LocalKeys.ts";
import * as LocalKeyRoutes from "./localKeys/localKeyRoutes.ts";
import * as AccountRoutes from "./http/accountRoutes.ts";
import * as HookRoutes from "./automations/hookRoutes.ts";
import * as WorkOSWebhook from "./http/workosWebhook.ts";
import * as PreviewOpenRoutes from "./http/previewOpenRoutes.ts";
import { NO_STORE_HEADERS, requestCredentials, traceId } from "./http/credentials.ts";
import * as DiagnosticsRoutes from "./http/diagnosticsRoutes.ts";
import * as ThreadKindRoutes from "./http/threadKindRoutes.ts";
import * as EnvironmentApi from "./http/environmentApi.ts";
import * as Evlog from "./observability/Evlog.ts";
import * as Platform from "./platform.ts";
import * as PreviewSetup from "./previewSetup/PreviewSetup.ts";
import * as PreviewSetupRoutes from "./previewSetup/previewSetupRoutes.ts";
import { handleApiRequest } from "./api/apiRoutes.ts";
import {
  handleMcpRequest,
  PROTECTED_RESOURCE_PATHS,
  protectedResourceMetadata,
} from "./api/mcpRoutes.ts";
import * as CloudThreadService from "./thread/CloudThreadService.ts";
import * as ThreadsLive from "./thread/ThreadsLive.ts";
import type { LocalKeyVerifier } from "./models/ModelProtocol.ts";
import * as ThreadDirectory from "./thread/ThreadDirectory.ts";
import * as ThreadKindTurns from "./thread/ThreadKindTurns.ts";
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
  readonly traceExport?: Pick<Fetcher, "fetch">;
  readonly traceLimiter?: Pick<RateLimit, "limit">;
  /** The drives bucket and its preview prefix, where attachments live. */
  readonly attachments: AttachmentStorage;
}) =>
  Layer.merge(CloudAssets.layer, ClientTraceIntake.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ClientTraceExport.layer({
          ...(input.traceExport ? { TRACE_EXPORT: input.traceExport } : {}),
          ...(input.vars.TRACE_EXPORT_TOKEN
            ? { TRACE_EXPORT_TOKEN: input.vars.TRACE_EXPORT_TOKEN }
            : {}),
          ...(input.vars.T3CODE_TELEMETRY_ENABLED
            ? { T3CODE_TELEMETRY_ENABLED: input.vars.T3CODE_TELEMETRY_ENABLED }
            : {}),
        }),
        ClientTraceLimits.layer(
          input.traceLimiter,
          input.vars.ENVIRONMENT_ID ?? input.vars.SIGNALBOX_STAGE,
        ),
      ),
    ),
    Layer.provideMerge(TestSignIn.layer),
    Layer.provideMerge(Layer.mergeAll(TestIdentities.layer, TestSignInPolicy.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        CloudAccounts.layer,
        CloudThreadService.layer.pipe(Layer.provideMerge(ThreadsLive.layer)),
        PreviewSetup.layer,
        ThreadKindRoutes.layerTestClock,
      ),
    ),
    Layer.provideMerge(CloudAttachments.layer(input.attachments)),
    Layer.provideMerge(PreviewSetup.layerSourceHttp),
    // The Worker only reads threads; they are created in their user's object.
    Layer.provideMerge(Layer.mergeAll(ThreadContexts.layerWorker, ThreadKindTurns.layerNone)),
    Layer.provideMerge(CloudSessions.layer),
    Layer.provideMerge(GitHub.layerForUsers(GitHub.gitHubEndpoints(input.vars))),
    Layer.provideMerge(CloudTokens.layer),
    Layer.provideMerge(IdentityProvider.layer),
    Layer.provideMerge(Layer.mergeAll(CloudConfig.layer, PreviewSetup.layerConfig)),
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
    Layer.provideMerge(Evlog.layer),
  );

type Services = Layer.Success<ReturnType<typeof layerServices>>;

// Raw account routes resolve services per request, from the context the web
// handler is built with; the API groups take them when the router is built.
const routes = Layer.mergeAll(
  ClientTraceRoutes.layer,
  EnvironmentApi.layer,
  AccountRoutes.layer,
  TestSignInRoutes.layer,
  HookRoutes.layer,
  PreviewOpenRoutes.layer,
  DiagnosticsRoutes.layer,
  ThreadKindRoutes.layer,
  WorkOSWebhook.layer,
  GitHubRoutes.layer,
  ConnectionRoutes.layer,
  LocalKeyRoutes.layer,
  PreviewSetupRoutes.layer,
  AssetRoutes.layer,
  AttachmentRoutes.layer,
).pipe(Layer.provide(layerCors));

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

/** The request's wide event (`observability/Evlog.ts`), which the handler's `Effect.log*` lands on. */
type RequestLog = Evlog.UnitLog;

export interface CloudApp {
  readonly http: (request: Request, log?: RequestLog) => Promise<Response>;
  readonly webSocket: (request: Request, log?: RequestLog) => Promise<Response>;
  /** The ModelGateway's check of a local key's signature (`ModelGrants` in `worker.ts`). */
  readonly verifyLocalKey: LocalKeyVerifier;
  /** `/api/v1/`: the public API (`api/apiRoutes.ts`), streams and all. */
  readonly api: (request: Request, log?: RequestLog) => Promise<Response>;
  /** `/mcp` and its protected-resource metadata (`api/mcpRoutes.ts`). */
  readonly mcp: (request: Request, log?: RequestLog) => Promise<Response>;
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
          httpEffect.pipe(Effect.tapCause(logRequestFailure), Effect.provide(context)),
        );
      }).pipe(Scope.provide(scope)),
    )
    .catch(async (cause: unknown) => {
      await Effect.runPromise(Scope.close(scope, Exit.die(cause)));
      throw cause;
    });
  return {
    http: (request, log) =>
      http.then((handler) =>
        handler(request, log === undefined ? undefined : Evlog.loggerContext(log)),
      ),
    webSocket: (request, log) => runtime.runPromise(Evlog.provideLogger(openSocket(request), log)),
    verifyLocalKey: (token) => runtime.runPromise(verifyLocalKey(token)),
    api: (request, log) => runtime.runPromise(Evlog.provideLogger(handleApiRequest(request), log)),
    mcp: (request, log) =>
      runtime.runPromise(
        Evlog.provideLogger(
          PROTECTED_RESOURCE_PATHS.has(new URL(request.url).pathname)
            ? protectedResourceMetadata(request)
            : handleMcpRequest(request),
          log,
        ),
      ),
  };
};
