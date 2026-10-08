import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { WorkerEntrypoint } from "cloudflare:workers";

import { type CloudApp, layerServices, makeCloudApp } from "./app.ts";
import { labelOfHost, previewSettings } from "./thread/preview/previewHost.ts";
import { routePreview } from "./thread/preview/previewRoute.ts";
import { authorizeModel } from "./thread/runner/modelGrants.ts";
import { connectRunner, isRunnerSocketPath } from "./thread/runner/runnerRoute.ts";
import type { ThreadObjectEnv } from "./thread/ThreadObject.ts";
import type { UserObjectEnv } from "./user/UserObject.ts";

export { ThreadObject } from "./thread/ThreadObject.ts";
export { UserObject } from "./user/UserObject.ts";

/**
 * Signalbox Cloud: an environment that runs on Cloudflare. Clients connect to
 * it exactly as they connect to a self-hosted server. The web app is served
 * from the same origin as static assets; the paths a server owns (the same
 * list the Vite dev proxy forwards) reach this Worker.
 */

export interface CloudEnv extends UserObjectEnv, ThreadObjectEnv {
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
    if (previews !== null && labelOfHost(previews, hostname) !== null) {
      return routePreview(env.THREADS, request, { localWorkerd });
    }
    app ??= makeCloudApp(
      layerServices({
        vars: stringVars(env),
        users: env.USERS,
        threads: env.THREADS,
        localWorkerd,
      }),
    );
    if (pathname === "/ws") return app.webSocket(request);
    if (isRunnerSocketPath(pathname)) return connectRunner(env.THREADS, request, { localWorkerd });
    if (isDevProxiedPath(pathname)) return app.http(request);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<CloudEnv>;

/**
 * Asked by the ModelGateway Worker, over its service binding, before it serves
 * a harness's model request. Service bindings never reach the internet.
 */
export class ModelGrants extends WorkerEntrypoint<CloudEnv> {
  authorize(token: string, provider: ModelGatewayProvider) {
    return authorizeModel(this.env.THREADS, token, provider, {
      localWorkerd: this.env.LOCAL_WORKERD === "1",
    });
  }
}
