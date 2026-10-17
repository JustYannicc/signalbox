import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { WorkerEntrypoint } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type CloudApp, layerServices, makeCloudApp } from "./app.ts";
import { isPoolLinkPath, routePoolLink } from "./pool/poolLink.ts";
import type { PoolObjectEnv } from "./pool/PoolObject.ts";
import { isPreviewHost, labelOfHost, previewSettings } from "./thread/preview/previewHost.ts";
import { routePreview } from "./thread/preview/previewRoute.ts";
import { attachmentStorage } from "./attachments/attachmentObjects.ts";
import { handleDriveRequest, isDriveApiPath } from "./drive/driveRoutes.ts";
import { ModelGatewayRecord } from "./modelGateway/modelGatewayRecord.ts";
import { layerCrypto } from "./platform.ts";
import { reportModelRequest, serveModel } from "./thread/runner/modelGrants.ts";
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
import { isApiPath } from "./api/apiPaths.ts";
import { MCP_PATH } from "./api/mcpObject.ts";
import { PROTECTED_RESOURCE_PATHS } from "./api/mcpRoutes.ts";
import {
  executorTokenBindingStore,
  type ExecutorTokenBindingNamespace,
} from "./executor/ExecutorTokenBindings.ts";
import { EXECUTOR_JWKS_PATH, makeExecutorTokenService } from "./executor/ExecutorTokens.ts";

export { PoolObject, PoolStoreGateway } from "./pool/PoolObject.ts";
export { PreviewLinkRegistry } from "./pool/PreviewLinkRegistryDO.ts";
export { DriveObject } from "./drive/DriveObject.ts";
export { ThreadObject } from "./thread/ThreadObject.ts";
export { UserObject } from "./user/UserObject.ts";
export { ExecutorTokenBindingObject } from "./executor/ExecutorTokenBindingObject.ts";
export { AutomationHost, AutomationWorkflow } from "./automations/automationWorkflow.ts";

/**
 * Signalbox Cloud: an environment that runs on Cloudflare. Clients connect to
 * it exactly as they connect to a self-hosted server. The web app is served
 * from the same origin as static assets; the paths a server owns (the same
 * list the Vite dev proxy forwards) reach this Worker.
 */

export interface CloudEnv
  extends UserObjectEnv, ThreadObjectEnv, PoolObjectEnv, PreviewCleanupEnv, AutomationWorkflowEnv {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
  readonly EXECUTOR_TOKEN_BINDINGS: ExecutorTokenBindingNamespace;
  readonly EXECUTOR_TOKEN_ISSUER?: string;
  readonly EXECUTOR_TOKEN_PRIVATE_JWK?: string;
  readonly EXECUTOR_TOKEN_RETIRING_PUBLIC_JWKS?: string;
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

let app: CloudApp | undefined;
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
  app ??= makeCloudApp(
    layerServices({
      vars: stringVars(env),
      users: env.USERS,
      threads: env.THREADS,
      localWorkerd: env.LOCAL_WORKERD === "1",
      attachments: attachmentStorage(env),
    }),
    { executorTokens: executorTokensFor(env) },
  );
  return app;
};

export default {
  fetch(request, env) {
    const { hostname, pathname } = new URL(request.url);
    // The local switch drops the EU jurisdiction. A deployment carrying it by
    // mistake serves nothing rather than storing anyone's data elsewhere.
    const localWorkerd = env.LOCAL_WORKERD === "1";
    if (localWorkerd && !isLoopback(hostname)) {
      return new Response("LOCAL_WORKERD is set on a non-local host", { status: 503 });
    }
    // A preview origin serves the thread's dev server and nothing of the app.
    const previews = previewSettings(env);
    if (previews !== null && isPreviewHost(previews, hostname)) {
      return labelOfHost(previews, hostname) === null
        ? new Response("Not found", { status: 404 })
        : routePreview(env.THREADS, request, { localWorkerd });
    }
    const app = appFor(env);
    if (pathname === EXECUTOR_JWKS_PATH) {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return app.executorJwks();
    }
    if (pathname === "/ws") return app.webSocket(request);
    if (isRunnerSocketPath(pathname)) return connectRunner(env.THREADS, request, { localWorkerd });
    if (isSessionApiPath(pathname)) {
      return forwardSessionRequest(env.THREADS, request, { localWorkerd });
    }
    if (pathname === PREVIEW_CLEANUP_PATH) return handlePreviewCleanup(request, env);
    if (isPoolLinkPath(pathname)) return routePoolLink(env.POOLS, request, { localWorkerd });
    if (isDriveApiPath(pathname)) {
      return env.DRIVES === undefined || env.DRIVE_PACKS === undefined
        ? new Response("This cloud stores no drives.", { status: 404 })
        : handleDriveRequest(
            { ...env, DRIVES: env.DRIVES, DRIVE_PACKS: env.DRIVE_PACKS },
            request,
            { localWorkerd },
          );
    }
    if (isApiPath(pathname)) return app.api(request);
    if (pathname === MCP_PATH || PROTECTED_RESOURCE_PATHS.has(pathname)) return app.mcp(request);
    if (isDevProxiedPath(pathname)) return app.http(request);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<CloudEnv>;

const decodeModelGatewayRecord = Schema.decodeUnknownOption(ModelGatewayRecord);

/**
 * Asked by the ModelGateway Worker, over its service binding, to serve a
 * harness's model request, and told what each request did afterwards.
 * Service bindings never reach the internet.
 */

export class ModelGrants extends WorkerEntrypoint<CloudEnv> {
  /** Checks a request's token or local key and, granted, sends it to its pool. */
  serve(token: string, provider: ModelGatewayProvider, path: string, request: Request) {
    const { THREADS, USERS, POOLS, LOCAL_WORKERD } = this.env;
    // Only a local key needs the app, to check its signature; a turn's token never builds it.
    const verifyLocalKey = (key: string) => appFor(this.env).verifyLocalKey(key);
    return serveModel(
      {
        threads: THREADS,
        users: USERS,
        pools: POOLS,
        verifyLocalKey,
        token,
        provider,
        path,
        request,
      },
      { localWorkerd: LOCAL_WORKERD === "1" },
    );
  }

  /** A served request's record, for its thread or key. Anything that does not decode is dropped. */
  async report(record: unknown): Promise<void> {
    const decoded = decodeModelGatewayRecord(record);
    if (decoded._tag === "None") return;
    const { THREADS, USERS } = this.env;
    await reportModelRequest({ threads: THREADS, users: USERS }, decoded.value, {
      localWorkerd: this.env.LOCAL_WORKERD === "1",
    });
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
