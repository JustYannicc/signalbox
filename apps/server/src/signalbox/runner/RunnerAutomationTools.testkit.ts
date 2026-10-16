// @effect-diagnostics globalFetchInEffect:off - speaks MCP to a real loopback server, as the harness does.
import { expect } from "@effect/vitest";
import {
  AUTOMATION_PATHS,
  automationJson,
  type ToolRequest,
  type ToolResult,
} from "@signalbox/runner-protocol/AutomationProtocol";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { makeContextClient } from "./RunnerContextClient.ts";
import { startContextServer } from "./RunnerContextServer.ts";
import { CONTEXT_SERVER_NAME } from "./RunnerContextTools.ts";

/**
 * A cloud thread's machine as a harness reaches it: MCP over loopback, with
 * the turn's real context client forwarding automation calls to a fake of the
 * cloud's automation route.
 */

export const TOKEN = "sbd1.dGhyZWFk.c2ln";

/** One JSON-RPC request's body. */
const rpcBody = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

export interface Cloud {
  /** What the cloud was asked, in order, with the bearer it came with. */
  readonly requests: Array<ToolRequest & { readonly bearer: string | null }>;
  /** Answers the next calls; a number answers that HTTP status. */
  readonly answers: Array<ToolResult | number>;
}

export const serve = (
  options: {
    /** The thread the machine runs. */
    readonly threadId?: string;
    /** Answers calls `answers` doesn't; an empty automation list by default. */
    readonly respond?: (request: ToolRequest) => ToolResult;
  } = {},
) =>
  Effect.gen(function* () {
    const cloud: Cloud = { requests: [], answers: [] };
    const respond =
      options.respond ??
      ((): ToolResult => ({ _tag: "ok", result: { automations: [], builtIns: [] } }));
    const fakeCloud: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe(AUTOMATION_PATHS.tool);
      const asked = automationJson.toolRequest.decode(await request.text());
      cloud.requests.push({ ...asked, bearer: request.headers.get("authorization") });
      const next = cloud.answers.shift() ?? respond(asked);
      return typeof next === "number"
        ? new Response("The thread's owner is unavailable right now.", { status: next })
        : new Response(automationJson.tool.encode(next), { status: 200 });
    };
    const client = yield* makeContextClient({
      cloudUrl: "https://cloud.test/",
      access: { driveId: "my/personal/user_1", token: TOKEN, remoteToken: null },
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fakeCloud),
    );
    const server = yield* startContextServer({
      mountPoint: null,
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    });
    // The view the turn pins is the context API's; these tools only need the client.
    yield* server.pin({
      ...client,
      view: Effect.succeed({ driveId: "my/personal/user_1", contexts: [] }),
    });
    let session: string | null = null;
    let id = 0;
    const mcp = (method: string, params: unknown) =>
      Effect.promise(async () => {
        const response = await fetch(server.mcpServers[CONTEXT_SERVER_NAME]!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            ...(session === null ? {} : { "mcp-session-id": session }),
          },
          body: rpcBody(++id, method, params),
        });
        session = response.headers.get("mcp-session-id") ?? session;
        return (await response.json()) as { result?: any };
      });
    yield* mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const call = (name: string, args: Record<string, unknown>) =>
      Effect.map(
        mcp("tools/call", { name, arguments: args }),
        (answer) =>
          answer.result as { isError?: boolean; content: ReadonlyArray<{ text: string }> },
      );
    return { mcp, call, cloud };
  });
