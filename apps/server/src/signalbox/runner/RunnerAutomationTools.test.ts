// @effect-diagnostics globalFetchInEffect:off - speaks MCP to a real loopback server, as the harness does.
import { describe, expect, it } from "@effect/vitest";
import {
  AUTOMATION_PATHS,
  automationJson,
  type ToolRequest,
  type ToolResult,
} from "@signalbox/runner-protocol/AutomationProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Tool from "effect/ai/Tool";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { PullRequestsToolkit } from "../../mcp/toolkits/pullRequests/tools.ts";
import { AutomationToolkit } from "../../workflows/mcp/tools.ts";
import { RUNNER_AUTOMATION_TOOLS } from "./RunnerAutomationTools.ts";
import { makeContextClient } from "./RunnerContextClient.ts";
import { startContextServer } from "./RunnerContextServer.ts";
import { CONTEXT_SERVER_NAME } from "./RunnerContextTools.ts";

/**
 * The automation tools as a harness reaches them on a cloud thread's machine:
 * MCP over loopback, forwarded by the turn's real context client to a fake of
 * the cloud's automation route.
 */

const TOKEN = "sbd1.dGhyZWFk.c2ln";

const SOURCE = `export const meta = { name: "Weekly report", triggers: [{ cron: "0 9 * * 1" }] } as const;
export default workflow(async (w) => {
  await w.notify("Say hi", "Hi");
});
`;

interface Cloud {
  /** What the cloud was asked, in order, with the bearer it came with. */
  readonly requests: Array<ToolRequest & { readonly bearer: string | null }>;
  /** Answers the next calls; a number answers that HTTP status. */
  readonly answers: Array<ToolResult | number>;
}

const serve = Effect.gen(function* () {
  const cloud: Cloud = { requests: [], answers: [] };
  const fakeCloud: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toBe(AUTOMATION_PATHS.tool);
    cloud.requests.push({
      ...automationJson.toolRequest.decode(await request.text()),
      bearer: request.headers.get("authorization"),
    });
    const next = cloud.answers.shift() ?? { _tag: "ok", result: { automations: [], builtIns: [] } };
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
  const server = yield* startContextServer({ mountPoint: null });
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
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
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
      (answer) => answer.result as { isError?: boolean; content: ReadonlyArray<{ text: string }> },
    );
  return { mcp, call, cloud };
});

describe("automation tools on a cloud thread's machine (#434)", () => {
  it.effect("are the server's and upstream's tools: names, descriptions, inputs, hints", () =>
    Effect.gen(function* () {
      const { mcp } = yield* serve;
      const served = new Map(
        (
          (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
            name: string;
            description: string;
            inputSchema: unknown;
            annotations: { readOnlyHint: boolean; destructiveHint: boolean };
          }>
        ).map((tool) => [tool.name, tool]),
      );
      const declared: Record<string, Tool.Any> = {
        ...AutomationToolkit.tools,
        ...PullRequestsToolkit.tools,
      };
      for (const name of RUNNER_AUTOMATION_TOOLS) {
        const tool = declared[name]!;
        expect(served.get(name), name).toMatchObject({
          description: tool.description,
          inputSchema: Tool.getJsonSchema(tool),
          annotations: {
            readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
            destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          },
        });
      }
    }),
  );

  it.effect("forwards a call with the turn's drive token and answers the engine's JSON", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* serve;
      cloud.answers.push({ _tag: "ok", result: { waitId: "wait_1", callbackUrl: null } });
      const waiting = yield* call("wait_for", {
        until: "checks on #12 to finish",
        on: "pr.checks.failed",
        where: { number: 12 },
        timeout: { hours: 2 },
      });
      expect(waiting.isError).toBeUndefined();
      expect(waiting.content[0]!.text).toBe(
        JSON.stringify({ waitId: "wait_1", callbackUrl: null }),
      );
      expect(cloud.requests).toEqual([
        {
          name: "wait_for",
          input: {
            until: "checks on #12 to finish",
            on: "pr.checks.failed",
            where: { number: 12 },
            timeout: { hours: 2 },
          },
          bearer: `Bearer ${TOKEN}`,
        },
      ]);

      // upstream's watch_pull_request starts the cloud's "Watch pull request" built-in.
      yield* call("watch_pull_request", { url: "https://github.com/owner/repo/pull/12" });
      expect(cloud.requests[1]).toMatchObject({
        name: "watch_pull_request",
        input: { url: "https://github.com/owner/repo/pull/12" },
      });

      // The engine's refusal reaches the agent as a tool error, in its words.
      cloud.answers.push({ _tag: "failed", message: "No automation automation_9." });
      const refused = yield* call("automation_read", { automationId: "automation_9" });
      expect(refused).toMatchObject({
        isError: true,
        content: [{ text: "No automation automation_9." }],
      });
    }),
  );

  it.effect("compiles a save here and sends the compiled automation with it", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* serve;
      cloud.answers.push({ _tag: "ok", result: { ok: true, outline: "notify Say hi" } });
      const saved = yield* call("automation_save", { source: SOURCE, draft: true });
      expect(saved.content[0]!.text).toBe(JSON.stringify({ ok: true, outline: "notify Say hi" }));
      expect(cloud.requests).toHaveLength(1);
      const sent = cloud.requests[0]!;
      expect(sent.name).toBe("automation_save");
      expect(sent.input).toMatchObject({
        source: SOURCE,
        draft: true,
        compiled: {
          meta: { name: "Weekly report", triggers: [{ cron: "0 9 * * 1" }] },
          graph: { nodes: [{ type: "step", verb: "notify" }] },
        },
      });
      expect((sent.input as { compiled: { script: string } }).compiled.script).toContain("notify");

      // A file that doesn't compile answers its diagnostics without asking the cloud.
      const broken = yield* call("automation_save", { source: "export const x = 1;" });
      expect(JSON.parse(broken.content[0]!.text)).toMatchObject({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ message: "Export the workflow as the default export." }),
        ]),
      });
      expect(cloud.requests).toHaveLength(1);
    }),
  );

  it.effect("validates and reads the reference without the cloud", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* serve;
      const valid = JSON.parse(
        (yield* call("automation_validate", { source: SOURCE })).content[0]!.text,
      );
      expect(valid).toMatchObject({ ok: true, outline: expect.stringContaining("Say hi") });
      const invalid = yield* call("automation_validate", { source: "export const x = 1;" });
      expect(JSON.parse(invalid.content[0]!.text)).toMatchObject({ ok: false });

      const reference = JSON.parse((yield* call("automation_reference", {})).content[0]!.text);
      expect(reference.reference).toContain("workflow(");
      const missing = yield* call("automation_reference", { topic: "nope" });
      expect(missing).toMatchObject({ isError: true });
      expect(missing.content[0]!.text).toContain("steps, control-flow");
      expect(cloud.requests).toEqual([]);
    }),
  );

  it.live("retries a read the cloud couldn't answer, never a write", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* serve;
      cloud.answers.push(503);
      const listed = yield* call("automation_list", {});
      expect(listed.isError).toBeUndefined();
      expect(cloud.requests.map((request) => request.name)).toEqual([
        "automation_list",
        "automation_list",
      ]);

      cloud.answers.push(503);
      const run = yield* call("automation_run", { automationId: "automation_1" });
      expect(run.isError).toBe(true);
      expect(run.content[0]!.text).toContain("may not have happened");
      expect(cloud.requests.map((request) => request.name)).toEqual([
        "automation_list",
        "automation_list",
        "automation_run",
      ]);
    }),
  );
});
