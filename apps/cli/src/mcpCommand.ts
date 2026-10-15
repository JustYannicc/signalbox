// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the public MCP's access checks are the cloud API's own: it refuses agents human-only and destructive operations, and checks every call's scopes.
import { McpProtocol, McpServer } from "effect/ai";
import {
  layerSignalboxTools,
  SignalboxApi,
  SignalboxApiCallError,
  SignalboxToolkit,
} from "@signalbox/api/mcpTools";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, Flag } from "effect/cli";
import { HttpClient } from "effect/http";

import { callOperation, listCoverage } from "./http.ts";
import { resolveTarget } from "./target.ts";
import { asUserErrors } from "./userErrors.ts";

/**
 * `signalbox mcp`: Signalbox's MCP tools over stdio, for MCP clients that
 * can't sign in themselves. They act with your saved key, as an agent:
 * `claude mcp add signalbox -- signalbox mcp`. Clients that can sign in use
 * the cloud's `/mcp` with WorkOS AuthKit instead.
 */
export const mcpCommand = Command.make(
  "mcp",
  {
    url: Flag.optional(Flag.String("url")).pipe(
      Flag.withDescription("Which Signalbox, if not the one you signed in to."),
    ),
  },
  ({ url }) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(url);
      const coverage = yield* listCoverage(target);
      const http = yield* HttpClient.HttpClient;
      const api = SignalboxApi.of({
        coverage: (operation) => coverage.get(operation.name) ?? { served: false },
        call: (operation, input) =>
          callOperation(target, operation.name, input, { asAgent: true }).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.mapError((error) =>
              error._tag === "CliApiError"
                ? new SignalboxApiCallError({ status: error.status, error: error.body })
                : new SignalboxApiCallError({ status: 0, error: { message: error.message } }),
            ),
          ),
      });
      // oxlint-disable-next-line t3code/no-raw-mcp-registration -- the public MCP's access checks are the API's own (`callOperation`): agents get no human-only or destructive operation, and every call goes through the RPC scope check.
      const server = McpServer.toolkit(SignalboxToolkit).pipe(
        Layer.provide(layerSignalboxTools),
        Layer.provideMerge(
          McpServer.layerStdio({
            name: "Signalbox",
            version: "1",
            protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25, McpProtocol.v2026_07_28],
          }),
        ),
        Layer.provide(Layer.succeed(SignalboxApi, api)),
      );
      return yield* Layer.launch(server);
    }).pipe(asUserErrors),
).pipe(Command.withDescription("Serve Signalbox's MCP tools over stdio, with your key."));
