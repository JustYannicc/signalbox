import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { WorkerEntrypoint } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import { withEvlog } from "evlog/workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type CloudApp, layerServices, makeCloudApp } from "./app.ts";
import * as Evlog from "./observability/Evlog.ts";
import { isPoolLinkPath, routePoolLink } from "./pool/poolLink.ts";
import type { PoolObjectEnv } from "./pool/PoolObject.ts";
import { isPreviewHost, labelOfHost, previewSettings } from "./thread/preview/previewHost.ts";
import { routePreview } from "./thread/preview/previewRoute.ts";
import { attachmentStorage } from "./attachments/attachmentObjects.ts";
import { handleDriveRequest, isDriveApiPath } from "./drive/driveRoutes.ts";
import { ModelGatewayRecord } from "./models/ModelRecords.ts";
import { layerCrypto } from "./platform.ts";
import * as ModelAccess from "./models/ModelAccess.ts";
import { layerModelAccess } from "./models/cloudflare.ts";
import { connectRunner, isRunnerSocketPath } from "./thread/runner/runnerRoute.ts";
import { forwardSessionRequest, isSessionApiPath } from "./thread/session/sessionRoutes.ts";
import {
  handlePreviewCleanup,
  PREVIEW_CLEANUP_PATH,
  type PreviewCleanupEnv,
} from "./previewSetup/previewCleanup.ts";
import type { ThreadObjectEnv } from "./thread/ThreadObject.ts";
import type { UserObjectEnv } from "./user/UserObject.ts";
import type { AutomationWorkflowEnv } from "./automations/automationWorkflow.ts";
import type { HarnessDurableStateBindings } from "./harness/HarnessDurableState.ts";
import { isApiPath } from "./api/apiPaths.ts";
import { MCP_PATH } from "./api/mcpObject.ts";
import { PROTECTED_RESOURCE_PATHS } from "./api/mcpRoutes.ts";
import {
  executorTokenBindingStore,
  type ExecutorTokenBindingNamespace,
} from "./executor/ExecutorTokenBindings.ts";
import { EXECUTOR_JWKS_PATH, makeExecutorTokenService } from "./executor/ExecutorTokens.ts";
import { recoveryDrillsEnabled } from "./thread/RecoveryDrill.ts";
import { threadObjectStub } from "./thread/ThreadDirectory.ts";

export { PoolObject, PoolStoreGateway } from "./pool/PoolObject.ts";
export { PreviewLinkRegistry } from "./pool/PreviewLinkRegistryDO.ts";
export { DriveObject } from "./drive/DriveObject.ts";
export { SearchIndexObject } from "./search/CloudflareSearchIndex.ts";
export { ThreadObject } from "./thread/ThreadObject.ts";
export { UserObject } from "./user/UserObject.ts";
export { ExecutorTokenBindingObject } from "./executor/ExecutorTokenBindingObject.ts";
export { AutomationHost, AutomationWorkflow } from "./automations/automationWorkflow.ts";
export { HarnessRunStoreObject } from "./harness/HarnessRunStoreObject.ts";
export { HarnessFilesStoreObject } from "./harness/HarnessFilesStoreObject.ts";
export { HarnessThreadSupervisorObject } from "./harness/HarnessThreadSupervisorObject.ts";
export { HarnessProcessExecutionEntrypoint } from "./harness/HarnessProcessExecutionEntrypoint.ts";
export { HarnessProcessExecutionShardObject } from "./harness/HarnessProcessExecutionShardObject.ts";
export { HarnessProcessPlacementStoreObject } from "./harness/HarnessProcessPlacementStoreObject.ts";

/**
 * Signalbox Cloud: an environment that runs on Cloudflare. Clients connect to
 * it exactly as they connect to a self-hosted server. The web app is served
 * from the same origin as static assets; the paths a server owns (the same
 * list the Vite dev proxy forwards) reach this Worker.
 */

export interface CloudEnv
  extends
    UserObjectEnv,
    Omit<ThreadObjectEnv, "ENVIRONMENT_ID">,
    PoolObjectEnv,
    PreviewCleanupEnv,
    AutomationWorkflowEnv,
    HarnessDurableStateBindings {
  readonly CLIENT_TRACE_LIMITER?: Pick<RateLimit, "limit">;
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
  readonly EXECUTOR_TOKEN_BINDINGS: ExecutorTokenBindingNamespace;
  readonly EXECUTOR_TOKEN_ISSUER?: string;
  readonly EXECUTOR_TOKEN_PRIVATE_JWK?: string;
  readonly EXECUTOR_TOKEN_RETIRING_PUBLIC_JWKS?: string;
  readonly TRACE_EXPORT?: Fetcher;
  readonly TRACE_EXPORT_TOKEN?: string;
}

/** Plain string vars and secrets, for the config provider. Bindings are objects. */
function stringVars(env: CloudEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "EXECUTOR_TOKEN_PRIVATE_JWK" && typeof entry[1] === "string",
    ),
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Preview origins under `wrangler dev` are subdomains of localhost, which browsers resolve to loopback. */
const isLoopback = (hostname: string) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");

let cloudApp: CloudApp | undefined;
let executorTokens: ReturnType<typeof makeExecutorTokenService> | undefined;

const executorTokensFor = (env: CloudEnv) =>
  (executorTokens ??= makeExecutorTokenService(
    env,
    executorTokenBindingStore(env.EXECUTOR_TOKEN_BINDINGS, {
      localWorkerd: env.LOCAL_WORKERD === "1",
    }),
    {
      nowSeconds: () =>
        Effect.runPromise(Clock.currentTimeMillis).then((milliseconds) =>
          Math.floor(milliseconds / 1000),
        ),
      newJti: () =>
        Effect.runPromise(
          Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(Effect.provide(layerCrypto)),
        ),
    },
  ));

const appFor = (env: CloudEnv) => {
  cloudApp ??= makeCloudApp(
    layerServices({
      vars: stringVars(env),
      ...(env.TRACE_EXPORT ? { traceExport: env.TRACE_EXPORT } : {}),
      ...(env.CLIENT_TRACE_LIMITER ? { traceLimiter: env.CLIENT_TRACE_LIMITER } : {}),
      users: env.USERS,
      threads: env.THREADS,
      localWorkerd: env.LOCAL_WORKERD === "1",
      drives: env.DRIVES !== undefined && env.DRIVE_PACKS !== undefined,
      attachments: attachmentStorage(env),
    }),
    { executorTokens: executorTokensFor(env) },
  );
  return cloudApp;
};

Evlog.init();

/** Everything but preview origins: one wide event per request, whose `route` says which part served it. */
const app = withEvlog<CloudEnv>((request, env, _ctx, log) => {
  const { pathname } = new URL(request.url);
  const routed = <A>(route: Evlog.Route, response: A) => {
    log.set({ route } satisfies Evlog.CloudFields);
    return response;
  };
  const localWorkerd = env.LOCAL_WORKERD === "1";
  const cloud = appFor(env);
  if (pathname === EXECUTOR_JWKS_PATH) {
    if (request.method !== "GET")
      return routed("http", new Response("Method not allowed", { status: 405 }));
    return routed("http", cloud.executorJwks());
  }
  if (pathname === "/ws") return routed("socket", cloud.webSocket(request, log));
  if (isRunnerSocketPath(pathname)) {
    return routed("runner", connectRunner(env.THREADS, request, { localWorkerd }));
  }
  if (isSessionApiPath(pathname)) {
    return routed("session", forwardSessionRequest(env.THREADS, request, { localWorkerd }));
  }
  if (pathname === PREVIEW_CLEANUP_PATH) {
    return routed("preview-cleanup", handlePreviewCleanup(request, env));
  }
  if (isPoolLinkPath(pathname)) {
    return routed("pool-link", routePoolLink(env.POOLS, request, { localWorkerd }));
  }
  if (isDriveApiPath(pathname)) {
    return routed(
      "drive",
      env.DRIVES === undefined || env.DRIVE_PACKS === undefined
        ? new Response("This cloud stores no drives.", { status: 404 })
        : handleDriveRequest(
            { ...env, DRIVES: env.DRIVES, DRIVE_PACKS: env.DRIVE_PACKS },
            request,
            {
              localWorkerd,
            },
          ),
    );
  }
  if (isApiPath(pathname)) return routed("api", cloud.api(request, log));
  if (pathname === MCP_PATH || PROTECTED_RESOURCE_PATHS.has(pathname)) {
    return routed("mcp", cloud.mcp(request, log));
  }
  if (isDevProxiedPath(pathname)) return routed("http", cloud.http(request, log));
  return routed("assets", env.ASSETS.fetch(request));
}, Evlog.requestOptions);

export default {
  fetch(request, env, ctx) {
    const { hostname } = new URL(request.url);
    // The local switch drops the EU jurisdiction. A deployment carrying it by
    // mistake serves nothing rather than storing anyone's data elsewhere.
    const localWorkerd = env.LOCAL_WORKERD === "1";
    if (localWorkerd && !isLoopback(hostname)) {
      return new Response("LOCAL_WORKERD is set on a non-local host", { status: 503 });
    }
    // A preview origin serves the thread's dev server and nothing of the app.
    // A dev server's every module request is no unit of Signalbox's work, so it has no event.
    const previews = previewSettings(env);
    if (previews !== null && isPreviewHost(previews, hostname)) {
      return labelOfHost(previews, hostname) === null
        ? new Response("Not found", { status: 404 })
        : routePreview(env.THREADS, request, { localWorkerd });
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<CloudEnv>;

const decodeModelGatewayRecord = Schema.decodeUnknownOption(ModelGatewayRecord);

let modelAccess: ModelAccess.ModelAccess["Service"] | undefined;

const modelAccessFor = (env: CloudEnv) => {
  modelAccess ??= Effect.runSync(
    ModelAccess.ModelAccess.pipe(
      Effect.provide(
        layerModelAccess(
          {
            threads: env.THREADS,
            users: env.USERS,
            pools: env.POOLS,
            // A turn token never initializes the app or needs its signing secret.
            verifyLocalKey: (key) => appFor(env).verifyLocalKey(key),
          },
          { localWorkerd: env.LOCAL_WORKERD === "1" },
        ),
      ),
    ),
  );
  return modelAccess;
};

/**
 * Asked by the ModelGateway Worker, over its service binding, to serve a
 * harness's model request, and told what each request did afterwards.
 * Service bindings never reach the internet.
 */

export class ModelGrants extends WorkerEntrypoint<CloudEnv> {
  /** Checks a request's token or local key and, granted, sends it to its pool. */
  serve(token: string, provider: ModelGatewayProvider, path: string, request: Request) {
    return modelAccessFor(this.env).serve({ token, provider, path, request });
  }

  /** A served request's record, for its thread or key. Anything that does not decode is dropped. */
  async report(record: unknown): Promise<void> {
    const decoded = decodeModelGatewayRecord(record);
    if (decoded._tag === "None") return;
    await modelAccessFor(this.env).report(decoded.value);
  }
}

/** Executor's verifier can call only the live-authorization RPC on this private entrypoint. */
export class ExecutorAuthority extends WorkerEntrypoint<CloudEnv> {
  async authorizeExecutor(claims: unknown): Promise<{ active: boolean }> {
    try {
      return await appFor(this.env).authorizeExecutor(claims);
    } catch {
      return { active: false };
    }
  }
}

/** Account operators bind a temporary probe Worker to this entrypoint; it has no public route. */
export class RecoveryDrillOperator extends WorkerEntrypoint<CloudEnv> {
  async thread(threadId: string, userId: string, input: unknown) {
    if (!recoveryDrillsEnabled(this.env)) return { error: "disabled" };
    const stub = threadObjectStub(this.env.THREADS, ThreadId.make(threadId), {
      localWorkerd: false,
    });
    if (stub.recoveryDrill === undefined) return { error: "unsupported" };
    return stub.recoveryDrill(userId, input);
  }
}
