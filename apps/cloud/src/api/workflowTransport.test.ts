import { workosStubLayer } from "@signalbox/account/WorkOSTesting";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { signLocalKey } from "../localKeys/LocalKeys.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import { ThreadEngine } from "../thread/ThreadEngine.ts";
import { coordinatorId, siblingId, scriptPath, seedWorkflows } from "../thread/workflowTestKit.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { handleApiRequest } from "./apiRoutes.ts";
import { handleMcpRequest } from "./mcpRoutes.ts";

const userId = "user_1";
const threadId = ThreadId.make("workflow-thread");
const scriptInput = { threadId, scriptPath, subagentId: coordinatorId };
const stopInput = { threadId, subagentId: coordinatorId };
const toolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
});
const rpcAnswer = Schema.Struct({ result: Schema.optional(toolResult) });
const decodeAnswer = Schema.decodeUnknownSync(Schema.fromJsonString(rpcAnswer));

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const layer = Layer.mergeAll(
    CloudTokens.layer.pipe(Layer.provide(layerConfig())),
    layerConfig(),
    workosStubLayer({}),
    Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory),
  );
  const keyFor = (
    who: string,
    scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope>,
  ) =>
    Effect.gen(function* () {
      yield* cloud.userDirectory.forUser(who).recordSignIn({ id: who, email: "a@b.c" });
      const key = yield* cloud.userDirectory
        .forUser(who)
        .createLocalKey("test", { scopes, model: false });
      if (key._tag !== "created") throw new Error("No key");
      return yield* signLocalKey(who, key.secret).pipe(Effect.provide(layer));
    });
  const key = yield* keyFor(userId, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
  const post = (operation: string, input: object, credential = key) =>
    handleApiRequest(
      new Request(`https://cloud.test/api/v1/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.flatMap((response) =>
        Effect.promise(async () => ({ status: response.status, body: await response.json() })),
      ),
    );
  const pool = cloud.pools.directory.forPool(`${userId}:personal`);
  yield* pool.create({ userId }, { name: "Personal", personal: true });
  const login = yield* pool.startLogin({ userId }, "claude");
  yield* pool.completeLogin(
    { userId },
    `http://localhost:54545/callback?code=test&state=${login.state}`,
  );
  yield* pool.loginStatus({ userId }, login.state);
  const created = yield* post("threads.create", {
    threadId,
    commandId: "launch-workflow",
    projectId: "scratch",
    title: "Workflow",
    modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: "first", text: "Review", attachments: [] },
  });
  expect(created, JSON.stringify(created)).toMatchObject({ status: 200 });
  yield* cloud.inThread(threadId, seedWorkflows);

  const mcp = (credential = key) => {
    let session: string | null = null;
    let id = 0;
    const rpc = (method: string, params: object) =>
      handleMcpRequest(
        new Request("https://cloud.test/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session === null
              ? {}
              : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.flatMap((response) =>
          Effect.promise(async () => {
            session = response.headers.get("mcp-session-id") ?? session;
            const text = await response.text();
            return text.trimStart().startsWith("{")
              ? text
              : text
                  .split("\n")
                  .find((line) => line.startsWith("data:"))!
                  .slice(5);
          }),
        ),
      );
    return {
      initialize: rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
      call: (operation: string, input: object) =>
        rpc("tools/call", { name: "signalbox_call", arguments: { operation, input } }).pipe(
          Effect.map((answer) => decodeAnswer(answer).result!),
        ),
    };
  };
  return { cloud, post, keyFor, mcp };
});

describe("workflow API and MCP", () => {
  it.effect(
    "reads the retained revision and stops the addressed workflow through HTTP and MCP",
    () =>
      Effect.gen(function* () {
        const { cloud, post, mcp } = yield* setup;
        const http = yield* post("threads.getWorkflowScript", scriptInput);
        expect(http.status).toBe(200);
        expect(http.body).toMatchObject({
          subagentId: coordinatorId,
          revision: "revision:workflow-one",
          contents: "// exact workflow-one\nawait review();",
        });
        const client = mcp();
        yield* client.initialize;
        const inspected = yield* client.call("threads.getWorkflowScript", scriptInput);
        expect(inspected.isError ?? false).toBe(false);
        expect(JSON.parse(inspected.content[0]!.text)).toEqual(http.body);
        const stopped = yield* client.call("threads.stopWorkflow", stopInput);
        expect(stopped.isError ?? false).toBe(false);
        expect((yield* post("threads.stopWorkflow", stopInput)).status).toBe(200);
        const projection = yield* cloud.inThread(
          threadId,
          ThreadEngine.use((engine) => engine.projection),
        );
        expect(projection!.subagents.find((task) => task.id === coordinatorId)?.status).toBe(
          "cancelled",
        );
        expect(projection!.subagents.find((task) => task.id === siblingId)?.status).toBe("running");
        expect((yield* post("threads.getWorkflowScript", scriptInput)).body).toEqual(http.body);
      }),
  );

  it.effect(
    "enforces read and operate scopes and hides another person's workflows on both transports",
    () =>
      Effect.gen(function* () {
        const { post, keyFor, mcp } = yield* setup;
        const reader = yield* keyFor(userId, [AuthOrchestrationReadScope]);
        const operator = yield* keyFor(userId, [AuthOrchestrationOperateScope]);
        const stranger = yield* keyFor("user_2", [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        expect((yield* post("threads.stopWorkflow", stopInput, reader)).status).toBe(403);
        expect((yield* post("threads.getWorkflowScript", scriptInput, operator)).status).toBe(403);
        expect((yield* post("threads.getWorkflowScript", scriptInput, stranger)).status).toBe(422);
        expect((yield* post("threads.stopWorkflow", stopInput, stranger)).status).toBe(422);
        const readClient = mcp(reader);
        yield* readClient.initialize;
        expect((yield* readClient.call("threads.stopWorkflow", stopInput)).isError).toBe(true);
        const strangerClient = mcp(stranger);
        yield* strangerClient.initialize;
        const hidden = yield* strangerClient.call("threads.getWorkflowScript", scriptInput);
        expect(hidden.isError).toBe(true);
        expect(hidden.content[0]!.text).not.toContain("await review()");
        expect((yield* strangerClient.call("threads.stopWorkflow", stopInput)).isError).toBe(true);
      }),
  );
});
