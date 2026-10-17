// @effect-diagnostics globalFetchInEffect:off - speaks MCP to a real loopback server and fakes only the cloud endpoint.
import { describe, expect, it } from "@effect/vitest";
import {
  LEARNER_PATHS,
  LEARNER_TOOL_NAMES,
  LearnerAddStatementInput,
  LearnerLogEventInput,
  LearnerLensesInput,
  LearnerQueryInput,
  learnerJson,
  type LearnerToolRequest,
  type LearnerToolResult,
} from "@signalbox/runner-protocol/LearnerProtocol";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { makeContextClient } from "./RunnerContextClient.ts";
import { startContextServer } from "./RunnerContextServer.ts";
import { CONTEXT_SERVER_NAME } from "./RunnerContextTools.ts";

const TOKEN = "sbd1.dGhyZWFk.c2ln";
const result = { _tag: "ok", result: { lenses: [], precedents: [], answerAlone: false } } as const;

const serve = Effect.gen(function* () {
  const requests: Array<LearnerToolRequest & { bearer: string | null }> = [];
  const answers: Array<LearnerToolResult> = [];
  const fakeCloud: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toBe(LEARNER_PATHS.tool);
    const asked = learnerJson.toolRequest.decode(await request.text());
    requests.push({ ...asked, bearer: request.headers.get("authorization") });
    return new Response(learnerJson.tool.encode(answers.shift() ?? result), { status: 200 });
  };
  const client = yield* makeContextClient({
    cloudUrl: "https://cloud.test/",
    access: { driveId: "my/personal/user_1", token: TOKEN, remoteToken: null },
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fakeCloud),
  );
  const server = yield* startContextServer({ mountPoint: null });
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
      return (await response.json()) as {
        result?: {
          tools?: unknown;
          isError?: boolean;
          content?: ReadonlyArray<{ text: string }>;
        };
      };
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
  return { mcp, call, requests, answers };
});

describe("learner tools on a cloud thread's machine (#668)", () => {
  it.effect("expose only the four learner operations with scope-bound inputs", () =>
    Effect.gen(function* () {
      const { mcp } = yield* serve;
      const listed = (yield* mcp("tools/list", {})).result?.tools;
      if (!Array.isArray(listed)) throw new Error("MCP tools/list did not return a tool list.");
      const tools = listed as ReadonlyArray<{
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
        annotations: { readOnlyHint: boolean };
      }>;
      const learnerNames = new Set<string>(LEARNER_TOOL_NAMES);
      expect(tools.map((tool) => tool.name).filter((name) => learnerNames.has(name))).toEqual(
        LEARNER_TOOL_NAMES,
      );
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of LEARNER_TOOL_NAMES) {
        const properties = byName.get(name)!.inputSchema.properties ?? {};
        expect(properties).not.toHaveProperty("scope");
        expect(properties).not.toHaveProperty("treeId");
        expect(properties).not.toHaveProperty("userId");
        if (name !== "learner_lenses") expect(properties).not.toHaveProperty("folderId");
      }
      expect(byName.get("learner_lenses")!.inputSchema.properties).toHaveProperty("folderId");

      // Keep the MCP declarations pinned to their wire schemas.
      expect(Object.keys(LearnerLogEventInput.fields)).toEqual([
        "eventId",
        "source",
        "kind",
        "content",
        "input",
        "objectId",
        "usedLensId",
      ]);
      expect(Object.keys(LearnerQueryInput.fields)).toEqual(["task"]);
      expect(Object.keys(LearnerAddStatementInput.fields)).toEqual(["text", "reason"]);
      expect(Object.keys(LearnerLensesInput.fields)).toEqual(["folderId", "task"]);
    }),
  );

  it.effect("forwards event, query, statement, and lens calls with the turn's drive token", () =>
    Effect.gen(function* () {
      const { call, requests } = yield* serve;
      const event = {
        eventId: "ask:ask_1:draft",
        source: "asks",
        kind: "draft",
        content: "Yes, the checks passed.",
        input: "Can this go ahead?",
        objectId: "ask_1",
        usedLensId: "lens_1",
      };
      const calls = [
        ["learner_log_event", event],
        ["learner_query", { task: "Can this go ahead?" }],
        [
          "learner_add_statement",
          { text: "Merge only after checks pass.", reason: "Keep main green." },
        ],
        ["learner_lenses", { folderId: "folder_1", task: "Can this go ahead?" }],
      ] as const;
      for (const [name, input] of calls) {
        const answer = yield* call(name, input);
        expect(answer.isError).toBeUndefined();
        expect(answer.content[0]!.text).toBe(JSON.stringify(result.result));
      }
      expect(requests).toEqual(
        calls.map(([name, input]) => ({ name, input, bearer: `Bearer ${TOKEN}` })),
      );
    }),
  );

  it.effect("surfaces a cloud refusal as a tool error", () =>
    Effect.gen(function* () {
      const { call, answers } = yield* serve;
      answers.push({ _tag: "failed", message: "That folder is not below this thread's home." });
      expect(yield* call("learner_lenses", { folderId: "folder_elsewhere" })).toMatchObject({
        isError: true,
        content: [{ text: "That folder is not below this thread's home." }],
      });
    }),
  );
});
