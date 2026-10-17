import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { handleApiRequest } from "../api/apiRoutes.ts";
import { handleMcpRequest } from "../api/mcpRoutes.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as Environment from "../environment.ts";
import { signLocalKey } from "../localKeys/LocalKeys.ts";
import { poolObjectName } from "../pool/PoolDirectory.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as ThreadRunner from "./runner/ThreadRunner.ts";

const threadId = "preparation-api-thread";
const userId = "preparation-owner";
const scopes = ["orchestration:read", "orchestration:operate"] as const;
const decodeSnapshot = Schema.decodeUnknownSync(WorktreeSetupSnapshot);

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const layer = Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected network request")),
    ),
    CloudTokens.layer.pipe(Layer.provide(layerConfig())),
    layerConfig(),
    Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory),
  );
  const keyFor = (personId: string, readOnly = false) =>
    Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(personId);
      yield* user.recordSignIn({ id: personId, email: `${personId}@example.test` });
      const made = yield* user.createLocalKey(readOnly ? "reader" : "writer", {
        scopes: readOnly ? ["orchestration:read"] : scopes,
        model: false,
      });
      if (made._tag !== "created") throw new Error("No key");
      return yield* signLocalKey(personId, made.secret).pipe(Effect.provide(layer));
    });
  const ownerKey = yield* keyFor(userId);
  const strangerKey = yield* keyFor("preparation-stranger");
  const readerKey = yield* keyFor(userId, true);
  const pool = cloud.pools.directory.forPool(poolObjectName(userId, "personal"));
  yield* pool.create({ userId }, { name: "Personal", personal: true });
  const login = yield* pool.startLogin({ userId }, "claude");
  yield* pool.completeLogin({ userId }, `http://localhost/callback?code=c&state=${login.state}`);
  yield* pool.loginStatus({ userId }, login.state);
  const api = (name: string, input: object, key = ownerKey) =>
    Effect.suspend(() =>
      handleApiRequest(
        new Request(`https://cloud.test/api/v1/${name}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      ),
    ).pipe(
      Effect.provide(layer),
      Effect.flatMap((response) =>
        Effect.promise(async () => ({
          status: response.status,
          body: (await response.json()) as unknown,
        })),
      ),
    );
  expect(
    (yield* api("threads.create", {
      commandId: "create",
      threadId,
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: "Private checkout",
      modelSelection: { instanceId: "claude_hub", model: "claude-fable-5-1" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    })).status,
  ).toBe(200);
  expect(
    (yield* api("threads.send", {
      commandId: "send",
      threadId,
      messageId: "same-message",
      text: "Prepare this thread",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
    })).status,
  ).toBe(200);
  const read = Effect.map(api("worktreeSetup.subscribe", { threadId }), (response) => {
    expect(response.status).toBe(200);
    return decodeSnapshot(response.body);
  });
  const initial = yield* read;
  if (initial.runId === undefined || initial.preparationGeneration === undefined)
    throw new Error("Missing guards");
  const target = {
    threadId: initial.threadId,
    runId: initial.runId,
    preparationGeneration: initial.preparationGeneration,
  };
  return { cloud, layer, api, read, target, initial, ownerKey, strangerKey, readerKey };
});

describe("preparation through production API and MCP", () => {
  it.effect(
    "serves status, targeted cancel, retained reconnect and same-run retry through HTTP, rejecting nonowners and stale or missing guards",
    () =>
      Effect.gen(function* () {
        const { cloud, api, read, target, initial, strangerKey, readerKey } = yield* setup;
        expect(initial).toMatchObject({
          phase: "running",
          worktreePath: null,
          setupScript: null,
          turnStarted: false,
        });
        expect((yield* api("worktreeSetup.subscribe", { threadId }, strangerKey)).status).toBe(422);
        expect((yield* api("worktreeSetup.cancel", target, strangerKey)).status).toBe(422);
        expect(
          (yield* api(
            "threads.retryPreparation",
            { ...target, commandId: "stranger-retry" },
            strangerKey,
          )).status,
        ).toBe(422);
        expect((yield* api("worktreeSetup.cancel", target, readerKey)).status).toBe(403);
        expect(
          (yield* api(
            "threads.retryPreparation",
            { ...target, commandId: "reader-retry" },
            readerKey,
          )).status,
        ).toBe(403);
        expect((yield* api("worktreeSetup.cancel", { threadId })).status).toBe(422);
        const machine = yield* cloud.inThread(
          threadId,
          ThreadRunner.ThreadRunner.use((runner) =>
            Effect.gen(function* () {
              const plan = yield* runner.reconcile;
              if (plan.ensure === null) throw new Error("No machine request");
              yield* runner.hello({
                type: "hello",
                protocolVersion: RUNNER_PROTOCOL_VERSION,
                imageVersion: "test",
                machineId: "same-machine",
                threadId: target.threadId,
                generation: plan.ensure.generation,
                token: plan.ensure.token,
                lastAckedSequence: 0,
              });
              const work = yield* runner.work;
              expect(work.turn?.runId).toBe(target.runId);
              return plan.ensure;
            }),
          ),
        );
        expect((yield* api("worktreeSetup.cancel", target)).body).toEqual({ cancelled: true });
        expect(yield* read).toMatchObject({ phase: "running", cancellationRequested: true });
        yield* cloud.inThread(
          threadId,
          ThreadRunner.ThreadRunner.use((runner) =>
            runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [{ kind: "preparation.cancelled", ...target }],
            }),
          ),
        );
        const terminal = yield* read;
        expect(terminal.phase).toBe("cancelled");
        expect(yield* read).toEqual(terminal);
        expect(
          (yield* api("threads.retryPreparation", {
            threadId,
            runId: target.runId,
            commandId: "missing-generation",
          })).status,
        ).toBe(422);
        expect(
          (yield* api("threads.retryPreparation", { ...target, commandId: "retry" })).status,
        ).toBe(200);
        const retried = yield* read;
        expect(retried).toMatchObject({
          runId: target.runId,
          phase: "running",
          preparationGeneration: target.preparationGeneration + 1,
        });
        expect(retried.sequence).toBeGreaterThan(terminal.sequence);
        expect((yield* api("worktreeSetup.cancel", target)).status).toBe(422);
        expect(
          (yield* api("threads.retryPreparation", { ...target, commandId: "old-generation" }))
            .status,
        ).toBe(422);
        expect(yield* read).toEqual(retried);
      }),
  );

  it.effect(
    "discovers and executes the same functional status, cancel and retry operations over authenticated MCP",
    () =>
      Effect.gen(function* () {
        const { layer, target, ownerKey, strangerKey } = yield* setup;
        const Answer = Schema.Struct({
          result: Schema.optional(Schema.Unknown),
          error: Schema.optional(Schema.Unknown),
        });
        const ToolResult = Schema.Struct({
          isError: Schema.optional(Schema.Boolean),
          content: Schema.Array(Schema.Struct({ text: Schema.String })),
        });
        const decodeAnswer = Schema.decodeUnknownSync(Schema.fromJsonString(Answer));
        const decodeTool = Schema.decodeUnknownSync(ToolResult);
        let id = 0;
        const client = (key: string) => {
          let session: string | null = null;
          const rpc = (method: string, params: object) =>
            handleMcpRequest(
              new Request("https://cloud.test/mcp", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${key}`,
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
                  const body = await response.text();
                  return decodeAnswer(
                    body.trimStart().startsWith("{")
                      ? body
                      : (body
                          .split("\n")
                          .find((line) => line.startsWith("data:"))
                          ?.slice(5) ?? "{}"),
                  );
                }),
              ),
            );
          return {
            rpc,
            tool: (operation: string, input: object) =>
              Effect.map(
                rpc("tools/call", { name: "signalbox_call", arguments: { operation, input } }),
                (answer) => decodeTool(answer.result),
              ),
          };
        };
        const owner = client(ownerKey);
        yield* owner.rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "preparation-proof", version: "1" },
        });
        const catalog = yield* owner.rpc("tools/call", {
          name: "signalbox_search",
          arguments: { query: "worktreeSetup", limit: 20 },
        });
        expect(JSON.stringify(catalog)).toContain("worktreeSetup.subscribe");
        expect(JSON.stringify(catalog)).toContain("worktreeSetup.cancel");
        const first = yield* owner.tool("worktreeSetup.subscribe", { threadId });
        expect(first.isError ?? false).toBe(false);
        expect(decodeSnapshot(JSON.parse(first.content[0]!.text))).toMatchObject({
          phase: "running",
        });
        const cancelled = yield* owner.tool("worktreeSetup.cancel", target);
        expect(cancelled.isError ?? false).toBe(false);
        const terminal = yield* owner.tool("worktreeSetup.subscribe", { threadId });
        expect(decodeSnapshot(JSON.parse(terminal.content[0]!.text)).phase).toBe("cancelled");
        expect(
          (yield* owner.tool("threads.retryPreparation", { ...target, commandId: "mcp-retry" }))
            .isError ?? false,
        ).toBe(false);
        expect((yield* owner.tool("worktreeSetup.cancel", target)).isError).toBe(true);
        const stranger = client(strangerKey);
        yield* stranger.rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stranger", version: "1" },
        });
        for (const [operation, input] of [
          ["worktreeSetup.subscribe", { threadId }],
          ["worktreeSetup.cancel", target],
          ["threads.retryPreparation", { ...target, commandId: "stranger-mcp-retry" }],
        ] as const) {
          expect((yield* stranger.tool(operation, input)).isError).toBe(true);
        }
      }),
  );
});
