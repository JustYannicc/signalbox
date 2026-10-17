import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type CloudApp, layerServices, makeCloudApp } from "./app.ts";
import { isPoolLinkPath, routePoolLink } from "./pool/poolLink.ts";
import type { PoolObjectEnv } from "./pool/PoolObject.ts";
import { isPreviewHost, labelOfHost, previewSettings } from "./thread/preview/previewHost.ts";
import { routePreview } from "./thread/preview/previewRoute.ts";
import { attachmentStorage } from "./attachments/attachmentObjects.ts";
import { handleDriveRequest, isDriveApiPath } from "./drive/driveRoutes.ts";
import { ModelGatewayRecord } from "./models/ModelRecords.ts";
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
import { isApiPath } from "./api/apiPaths.ts";
import { MCP_PATH } from "./api/mcpObject.ts";
import { PROTECTED_RESOURCE_PATHS } from "./api/mcpRoutes.ts";

export { PoolObject, PoolStoreGateway } from "./pool/PoolObject.ts";
export { PreviewLinkRegistry } from "./pool/PreviewLinkRegistryDO.ts";
export { DriveObject } from "./drive/DriveObject.ts";
export { SearchIndexObject } from "./search/CloudflareSearchIndex.ts";
export { ThreadObject } from "./thread/ThreadObject.ts";
export { UserObject } from "./user/UserObject.ts";
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
}

/** Plain string vars and secrets, for the config provider. Bindings are objects. */
function stringVars(env: CloudEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Preview origins under `wrangler dev` are subdomains of localhost, which browsers resolve to loopback. */
const isLoopback = (hostname: string) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");

let app: CloudApp | undefined;

const appFor = (env: CloudEnv) => {
  app ??= makeCloudApp(
    layerServices({
      vars: stringVars(env),
      users: env.USERS,
      threads: env.THREADS,
      localWorkerd: env.LOCAL_WORKERD === "1",
      attachments: attachmentStorage(env),
    }),
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
