import { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { handleMcpRequest } from "../api/mcpRoutes.ts";
import { setup, threadId } from "./preparationApiTesting.ts";
import * as ThreadRunner from "./runner/ThreadRunner.ts";

const decodeSnapshot = Schema.decodeUnknownSync(WorktreeSetupSnapshot);

describe("preparation through production API and MCP", () => {
  it.effect(
    "serves status, targeted cancel, retained reconnect and same-run retry through HTTP, rejecting nonowners and stale or missing guards",
    () =>
      Effect.gen(function* () {
        const { cloud, api, read, target, initial, strangerKey, readerKey, connect, changes } =
          yield* setup;
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
        const machine = yield* connect;
        const updates = yield* changes;
        const completed = yield* Deferred.make<void>();
        const cancellation = yield* api("worktreeSetup.cancel", target).pipe(
          Effect.tap(() => Deferred.succeed(completed, undefined)),
          Effect.forkChild,
        );
        yield* updates.pipe(
          Stream.filter((value) => value?.cancellationRequested === true),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* Deferred.isDone(completed)).toBe(false);
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
        expect((yield* Fiber.join(cancellation)).body).toEqual({ cancelled: true });
        expect((yield* api("worktreeSetup.cancel", target)).body).toEqual({ cancelled: true });
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
        yield* cloud.inThread(
          threadId,
          ThreadRunner.ThreadRunner.use((runner) => runner.work),
        );
        expect(
          (yield* api("threads.interrupt", {
            commandId: "http-stop-retry",
            threadId,
            runId: target.runId,
            holdQueue: true,
          })).status,
        ).toBe(200);
        expect(yield* read).toMatchObject({ phase: "running", cancellationRequested: true });
        yield* cloud.inThread(
          threadId,
          ThreadRunner.ThreadRunner.use((runner) =>
            runner.batch({
              generation: machine.generation,
              sequence: 2,
              items: [
                {
                  kind: "preparation.cancelled",
                  ...target,
                  preparationGeneration: retried.preparationGeneration!,
                },
              ],
            }),
          ),
        );
        expect(yield* read).toMatchObject({ phase: "cancelled", runId: target.runId });
      }),
  );

  it.effect(
    "discovers and executes the same functional status, cancel and retry operations over authenticated MCP",
    () =>
      Effect.gen(function* () {
        const { cloud, layer, target, ownerKey, strangerKey, connect, changes } = yield* setup;
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
        const machine = yield* connect;
        const updates = yield* changes;
        const completed = yield* Deferred.make<void>();
        const cancellation = yield* owner.tool("worktreeSetup.cancel", target).pipe(
          Effect.tap(() => Deferred.succeed(completed, undefined)),
          Effect.forkChild,
        );
        yield* updates.pipe(
          Stream.filter((value) => value?.cancellationRequested === true),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* Deferred.isDone(completed)).toBe(false);
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
        const cancelled = yield* Fiber.join(cancellation);
        expect(cancelled.isError ?? false).toBe(false);
        expect(JSON.parse(cancelled.content[0]!.text)).toEqual({ cancelled: true });
        expect((yield* owner.tool("worktreeSetup.cancel", target)).isError ?? false).toBe(false);
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
        yield* cloud.inThread(
          threadId,
          ThreadRunner.ThreadRunner.use((runner) => runner.work),
        );
        expect(
          (yield* owner.tool("threads.interrupt", {
            commandId: "mcp-stop-retry",
            threadId,
            runId: target.runId,
            holdQueue: true,
          })).isError ?? false,
        ).toBe(false);
        const stopping = yield* owner.tool("worktreeSetup.subscribe", { threadId });
        expect(decodeSnapshot(JSON.parse(stopping.content[0]!.text))).toMatchObject({
          phase: "running",
          cancellationRequested: true,
        });
        yield* cloud.inThread(
          threadId,
          ThreadRunner.ThreadRunner.use((runner) =>
            runner.batch({
              generation: machine.generation,
              sequence: 2,
              items: [
                {
                  kind: "preparation.cancelled",
                  ...target,
                  preparationGeneration: target.preparationGeneration + 1,
                },
              ],
            }),
          ),
        );
        const stopped = yield* owner.tool("worktreeSetup.subscribe", { threadId });
        expect(decodeSnapshot(JSON.parse(stopped.content[0]!.text)).phase).toBe("cancelled");
      }),
  );
});
