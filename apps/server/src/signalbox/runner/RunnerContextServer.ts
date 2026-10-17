// @effect-diagnostics nodeBuiltinImport:off - the context server is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the Runner's loopback context server has no T3 caller to check: the cloud authorizes every call with the thread's own token.
import { McpProtocol, McpServer } from "effect/ai";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import packageJson from "../../../package.json" with { type: "json" };
import type { ClaudeAgentSdkQueryRunnerShape } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { automationCaller, layerAutomationTools } from "./RunnerAutomationTools.ts";
import { type BranchDrive, layerBranchTools } from "./RunnerBranchTools.ts";
import {
  BROWSER_EXECUTABLE_ENV,
  type BrowserBackend,
  machineTabs,
  makeRunnerBrowser,
} from "./RunnerBrowser.ts";
import type { BrowserMirror } from "./RunnerBrowserMirror.ts";
import { layerPaymentTool, makePayments, paymentAsker } from "./RunnerBrowserPayment.ts";
import { type PersonSession, personTabs } from "./RunnerBrowserPerson.ts";
import {
  BROWSER_INSTRUCTIONS,
  BROWSER_SERVER_NAME,
  layerBrowserTools,
} from "./RunnerBrowserTools.ts";
import { type ContextClient, ContextClientError } from "./RunnerContextClient.ts";
import {
  CONTEXT_INSTRUCTIONS,
  CONTEXT_SERVER_NAME,
  layerContextTools,
} from "./RunnerContextTools.ts";
import { DAV_PATH, serveDav } from "./RunnerDrivesDav.ts";
import { mountDrives } from "./RunnerDrivesMount.ts";
import { makeDrivesView } from "./RunnerDrivesView.ts";
import { mcpToolTimeoutSec, type RunnerMcpServers } from "./RunnerModelAccess.ts";
import { layerScheduledTaskTools } from "./RunnerScheduledTaskTools.ts";
import { layerStatusLineTools } from "./RunnerStatusLineTools.ts";
import { layerSecretTools, type RunnerSecretRequests } from "./RunnerSecretTools.ts";

/**
 * One Runner's context server (#141), on a loopback port of its own: the
 * context tool as an MCP server for the harnesses (`/mcp`), and `/drives` as
 * a WebDAV share (`/dav`) for the `/drives` mount. The drive token stays in
 * the Runner: both read through the turn's `ContextClient`, which `pin`
 * replaces at every turn start along with the view of the drives. The MCP
 * server also publishes the thread's branch, saving it through the drive
 * `attachDrive` gives it, and serves the automation tools, which run in the
 * cloud (`RunnerAutomationTools.ts`), with upstream's scheduled-task tools as
 * automations (`RunnerScheduledTaskTools.ts`), and the thread's status line
 * (`RunnerStatusLineTools.ts`). `/browser` serves the thread's browser
 * (#402, #574) as its own MCP server, under the name agents know it by locally:
 * the machine's headless Chromium for its dev servers, and the person's
 * browser for real sites, which the turn's client opens in the cloud. It hands
 * payments there to the person (`RunnerBrowserPayment.ts`).
 */

const MCP_PATH = "/mcp";
const BROWSER_PATH = "/browser";

/** The person's browser session through the current turn's client, which holds the drive token. */
const personSession = (view: ReturnType<typeof makeDrivesView>): PersonSession => {
  const call = <A>(use: (client: ContextClient) => Effect.Effect<A, ContextClientError>) => {
    const client = view.client();
    // A rejection carries the client's error, whose message is for the agent.
    return client === null
      ? Promise.reject(
          new ContextClientError({
            message: "The browser opens real sites once the thread's first turn starts.",
          }),
        )
      : Effect.runPromise(use(client));
  };
  return {
    open: () => call((client) => client.browserSession),
    end: (sessionId) => call((client) => client.endBrowser({ sessionId })),
    signIn: (site) => call((client) => client.browserSignIn({ site })),
  };
};

export interface ContextServer {
  /** The MCP endpoints the harnesses are configured with, by server name. */
  readonly mcpServers: RunnerMcpServers;
  /** Takes this turn's view of the drives; a failure keeps the last one. */
  readonly pin: (client: ContextClient) => Effect.Effect<void>;
  /** The thread's drive, once a turn opens it: what publishing saves first. */
  readonly attachDrive: (drive: BranchDrive) => Effect.Effect<void>;
  /** The `preview_*` tools' browser as people watch it, for the preview tunnel. */
  readonly mirror: BrowserMirror | null;
}

export const startContextServer = Effect.fn("startContextServer")(function* (input: {
  /** Where to mount `/drives`; null serves the tools only (a development host). */
  readonly mountPoint: string | null;
  /** The browser behind the `preview_*` tools; the machine's and the person's by default. */
  readonly browser?: BrowserBackend;
  /** The thread this machine runs, which scheduled tasks wake. */
  readonly threadId?: string;
  readonly secretRequests?: RunnerSecretRequests;
}) {
  const view = makeDrivesView();
  let drive: BranchDrive | null = null;
  // Chromium starts with the first browser call and stops with the thread.
  const env = yield* HostProcess.Environment;
  // Payments are asked from the thread, so only a machine running one hands them over.
  const payments =
    input.browser === undefined && input.threadId !== undefined
      ? makePayments({ asker: paymentAsker(automationCaller(view), input.threadId) })
      : null;
  const browser =
    input.browser ??
    makeRunnerBrowser(
      {
        machine: machineTabs({ executable: env[BROWSER_EXECUTABLE_ENV], env }),
        person: personTabs(personSession(view)),
      },
      payments === null ? {} : { guard: payments.guard },
    );
  payments?.bind(browser);
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(async () => {
      await payments?.close();
      await browser.close();
    }).pipe(Effect.ignore),
  );

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
  const mcp = Layer.mergeAll(
    layerContextTools(view),
    layerBranchTools(view, () => drive),
    layerAutomationTools(view),
    layerScheduledTaskTools(view, input.threadId ?? null),
    layerStatusLineTools(view),
    input.secretRequests === undefined ? Layer.empty : layerSecretTools(input.secretRequests),
  ).pipe(
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
  // Fresh: every MCP server layer shares `McpServer.layer`, so a memoized one
  // would put the browser's tools on the context server too.
  const browserMcp = Layer.fresh(
    Layer.mergeAll(
      layerBrowserTools(browser),
      payments === null ? Layer.empty : layerPaymentTool(payments),
    ).pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: BROWSER_SERVER_NAME,
          version: packageJson.version,
          instructions: BROWSER_INSTRUCTIONS,
          path: BROWSER_PATH,
          protocols: [McpProtocol.v2025_06_18],
        }),
      ),
    ),
  );
  const served = yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(dav, mcp, browserMcp), {
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
    mcpServers: {
      [CONTEXT_SERVER_NAME]: `${origin}${MCP_PATH}`,
      [BROWSER_SERVER_NAME]: `${origin}${BROWSER_PATH}`,
    },
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
    attachDrive: (next) =>
      Effect.sync(() => {
        drive = next;
      }),
    mirror: browser.mirror ?? null,
  } satisfies ContextServer;
});

/** What a turn hands over for its drives: opens a client for that access. */
export type OpenContextClient = (access: DriveAccess) => Effect.Effect<ContextClient>;

/** `inner` with every Claude query reaching the Runner's MCP servers, their tools pre-approved. */
export const withContextServer = (
  inner: ClaudeAgentSdkQueryRunnerShape,
  mcpServers: RunnerMcpServers,
): ClaudeAgentSdkQueryRunnerShape => ({
  ...inner,
  open: (input) =>
    inner.open({
      ...input,
      options: {
        ...input.options,
        mcpServers: {
          ...input.options.mcpServers,
          ...Object.fromEntries(
            Object.entries(mcpServers).map(
              ([name, url]) =>
                [name, { type: "http", url, timeout: mcpToolTimeoutSec(name) * 1000 }] as const,
            ),
          ),
        },
        allowedTools: [
          ...(input.options.allowedTools ?? []),
          ...Object.keys(mcpServers).map((name) => `mcp__${name}__*`),
        ],
      },
    }),
});
