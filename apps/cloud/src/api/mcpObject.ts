// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the public MCP uses per-operation API reach checks in `callOperation`, plus the RPC scope check.
import { McpProtocol, McpServer } from "effect/ai";
import {
  layerSignalboxTools,
  SignalboxApi,
  SignalboxApiCallError,
  SignalboxToolkit,
} from "@signalbox/api/mcpTools";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import type * as Environment from "../environment.ts";
import { type ApiCaller, callOperation } from "./apiCall.ts";
import { API_HEADER, decodeApiCredential } from "./apiCredential.ts";
import { callerFor } from "./apiObject.ts";
import { cloudServes, cloudUnserved } from "./cloudCoverage.ts";

/**
 * Signalbox's MCP server (#436, #335), inside the person's user object. The
 * object is long-lived and one per person, so MCP sessions live here rather
 * than in a Worker isolate. The Worker verified the credential's signature and
 * forwarded it (`mcpRoutes.ts`); here it becomes the caller every tool call acts
 * as, always an agent.
 */

export const MCP_PATH = "/mcp";

const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: { code: "unauthorized", message: "This credential can't use Signalbox's MCP." } },
  { status: 401 },
);

const toolsFor = (input: {
  readonly caller: ApiCaller;
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly context: Context.Context<Effect.Services<ReturnType<typeof callOperation>>>;
}) =>
  SignalboxApi.of({
    coverage: (operation) => {
      if (cloudServes(operation)) return { served: true };
      const unserved = cloudUnserved(operation);
      return {
        served: false,
        ...(unserved?._tag === "gap" ? { issue: unserved.issue } : {}),
        ...(unserved?._tag === "exempt" ? { reason: unserved.reason } : {}),
      };
    },
    call: (operation, body) =>
      callOperation({
        operation,
        body,
        follow: false,
        caller: input.caller,
        identity: input.identity,
      }).pipe(
        Effect.provideContext(input.context),
        Effect.flatMap((answer) =>
          answer._tag === "json" && answer.status >= 200 && answer.status < 300
            ? Effect.succeed(answer.body)
            : Effect.fail(
                new SignalboxApiCallError({
                  status: answer._tag === "json" ? answer.status : 500,
                  error: answer._tag === "json" ? answer.body : null,
                }),
              ),
        ),
      ),
  });

/** The object's `/mcp` handler. Built once per object; sessions live as long as it does. */
export const makeMcpHandler = (input: {
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly userId: string;
  readonly context: Context.Context<
    | Effect.Services<ReturnType<typeof callOperation>>
    | Effect.Services<ReturnType<typeof callerFor>>
  >;
}) => {
  // Every request names its credential; the tools act as it, as an agent.
  const callerMiddleware = HttpRouter.middleware<{ provides: SignalboxApi }>()(
    Effect.succeed((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const credential = decodeApiCredential(request.headers[API_HEADER]);
        if (credential._tag === "None") return unauthorized;
        const resolved = yield* callerFor(credential.value, input.userId).pipe(
          Effect.provideContext(input.context),
          Effect.orElseSucceed(() => null),
        );
        if (resolved === null) return unauthorized;
        // Whatever the credential, an MCP client is an agent.
        const caller: ApiCaller = { ...resolved, kind: "agent" };
        return yield* httpEffect.pipe(
          Effect.provideService(
            SignalboxApi,
            toolsFor({ caller, identity: input.identity, context: input.context }),
          ),
        );
      }),
    ),
  ).layer;

  // oxlint-disable-next-line t3code/no-raw-mcp-registration -- the public MCP uses per-operation API reach checks in `callOperation`, plus the RPC scope check.
  const registration = McpServer.toolkit(SignalboxToolkit);
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off - the middleware provides it per request.
  const registered = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, SignalboxApi>
  >;
  const app = registered.pipe(
    Layer.provide(layerSignalboxTools),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "Signalbox",
        version: "1",
        path: MCP_PATH,
        protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25, McpProtocol.v2026_07_28],
        allowSessionTermination: true,
      }).pipe(Layer.provide(callerMiddleware)),
    ),
  );
  return HttpRouter.toWebHandler(app);
};
