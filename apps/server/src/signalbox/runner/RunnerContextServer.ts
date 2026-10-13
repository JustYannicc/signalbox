// @effect-diagnostics nodeBuiltinImport:off - the context server is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the Runner's loopback context server has no T3 caller to check: the cloud authorizes every read, and every tool is read-only.
import { McpProtocol, McpServer } from "effect/ai";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import packageJson from "../../../package.json" with { type: "json" };
import type { ClaudeAgentSdkQueryRunnerShape } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { ContextClient } from "./RunnerContextClient.ts";
import {
  CONTEXT_INSTRUCTIONS,
  CONTEXT_SERVER_NAME,
  layerContextTools,
} from "./RunnerContextTools.ts";
import { DAV_PATH, serveDav } from "./RunnerDrivesDav.ts";
import { mountDrives } from "./RunnerDrivesMount.ts";
import { makeDrivesView } from "./RunnerDrivesView.ts";

/**
 * One Runner's context server (#141), on a loopback port of its own: the
 * context tool as an MCP server for the harnesses (`/mcp`), and `/drives` as
 * a WebDAV share (`/dav`) for the `/drives` mount. The drive token stays in
 * the Runner: both read through the turn's `ContextClient`, which `pin`
 * replaces at every turn start along with the view of the drives.
 */

const MCP_PATH = "/mcp";

export interface ContextServer {
  /** The MCP endpoint the harnesses are configured with. */
  readonly mcpUrl: string;
  /** Takes this turn's view of the drives; a failure keeps the last one. */
  readonly pin: (client: ContextClient) => Effect.Effect<void>;
}

export const startContextServer = Effect.fn("startContextServer")(function* (input: {
  /** Where to mount `/drives`; null serves the tools only (a development host). */
  readonly mountPoint: string | null;
}) {
  const view = makeDrivesView();

  const dav = HttpRouter.add("*", `${DAV_PATH}/*`, (request) =>
    serveDav(view, {
      method: request.method,
      path: new URL(request.url, "http://localhost").pathname,
      headers: request.headers,
    }).pipe(
      Effect.map((answer) =>
        typeof answer.body === "string"
          ? HttpServerResponse.text(answer.body, { status: answer.status, headers: answer.headers })
          : HttpServerResponse.uint8Array(answer.body, {
              status: answer.status,
              headers: answer.headers,
            }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("reading /drives failed", Cause.pretty(cause)).pipe(
          Effect.as(HttpServerResponse.text("The drives are unavailable.", { status: 503 })),
        ),
      ),
    ),
  );
  const mcp = layerContextTools(view).pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        name: CONTEXT_SERVER_NAME,
        version: packageJson.version,
        instructions: CONTEXT_INSTRUCTIONS,
        path: MCP_PATH,
        protocols: [McpProtocol.v2025_06_18],
      }),
    ),
  );
  const served = yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(dav, mcp), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ),
    ),
  );
  const address = Context.get(served, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress")
    return yield* Effect.die("The context server has no port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const mount =
    input.mountPoint === null
      ? null
      : yield* mountDrives({ davUrl: `${origin}${DAV_PATH}/`, mountPoint: input.mountPoint });

  return {
    mcpUrl: `${origin}${MCP_PATH}`,
    pin: (client) =>
      view.pin(client).pipe(
        // Only a changed view needs rclone to drop what it listed.
        Effect.flatMap((changed) => (changed && mount !== null ? mount.refresh : Effect.void)),
        Effect.catch((error) =>
          Effect.logWarning("could not read this turn's view of the drives", {
            message: error.message,
          }),
        ),
      ),
  } satisfies ContextServer;
});

/** What a turn hands over for its drives: opens a client for that access. */
export type OpenContextClient = (access: DriveAccess) => Effect.Effect<ContextClient>;

/** `inner` with every Claude query reaching the context server, its read-only tools pre-approved. */
export const withContextServer = (
  inner: ClaudeAgentSdkQueryRunnerShape,
  mcpUrl: string,
): ClaudeAgentSdkQueryRunnerShape => ({
  ...inner,
  open: (input) =>
    inner.open({
      ...input,
      options: {
        ...input.options,
        mcpServers: {
          ...input.options.mcpServers,
          [CONTEXT_SERVER_NAME]: { type: "http", url: mcpUrl },
        },
        allowedTools: [...(input.options.allowedTools ?? []), `mcp__${CONTEXT_SERVER_NAME}__*`],
      },
    }),
});
