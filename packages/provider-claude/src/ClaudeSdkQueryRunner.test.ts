import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { makeClaudeUserMessage } from "@signalbox/provider-claude/ClaudeAdapter";
import { claudeSdkFrameTraceFor } from "@signalbox/provider-claude/ClaudeEventLatencyTrace";
import type { ClaudeAgentSdkProtocolLogEvent } from "@signalbox/provider-claude/ClaudeQueryProtocol";
import { ClaudeAgentSdkQueryRunnerError } from "@signalbox/provider-claude/ClaudeQueryRunner";
import {
  makeClaudeAgentSdkQueryRunner,
  type ClaudeSdkQuery,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";

const identity = {
  threadId: ThreadId.make("portable-claude-thread"),
  providerSessionId: ProviderSessionId.make("portable-claude-session"),
};

function fakeQuery(messages: ReadonlyArray<SDKMessage> = []): ClaudeSdkQuery {
  async function* frames() {
    yield* messages;
  }
  return Object.assign(frames(), {
    close: () => {},
    setMcpServers: async (_servers: Parameters<ClaudeSdkQuery["setMcpServers"]>[0]) => ({
      added: [],
      removed: [],
      errors: {},
    }),
    setModel: async (_model: string) => {},
    applyFlagSettings: async (_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]) => {},
    setPermissionMode: async (_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]) => {},
    stopTask: async (_taskId: string) => {},
    backgroundTasks: async (_toolUseId: string) => true,
    interrupt: async () => undefined,
  }) satisfies ClaudeSdkQuery;
}

const options = {
  sessionId: "portable-native-session",
  model: "claude-opus-4-6",
  tools: [],
  permissionMode: "default" as const,
};

describe("portable Claude SDK query lifecycle", () => {
  it.effect(
    "registers MCP through the control channel, delivers prompts and closes their stream",
    () =>
      Effect.gen(function* () {
        const events: ClaudeAgentSdkProtocolLogEvent[] = [];
        let prompt: AsyncIterable<SDKUserMessage> | undefined;
        let launchOptions: unknown;
        let registered: unknown;
        let closed = false;
        const query = fakeQuery();
        query.setMcpServers = async (servers) => {
          registered = servers;
          return { added: Object.keys(servers), removed: [], errors: {} };
        };
        query.close = () => {
          closed = true;
        };
        const runner = makeClaudeAgentSdkQueryRunner({
          allocateSessionId: Effect.succeed("allocated-session"),
          query: (input) =>
            Effect.sync(() => {
              prompt = input.prompt;
              launchOptions = input.options;
              return query;
            }),
          forkSession: async () => ({ sessionId: "forked-session" }),
          subagentLaunchToolUseId: async () => null,
          protocolLogger: () => (event) => Effect.sync(() => void events.push(event)),
        });
        const mcpServers = {
          signalbox: {
            type: "http" as const,
            url: "http://example.test/mcp",
            headers: { secret: "credential" },
          },
        };
        const session = yield* runner.open({ ...identity, options: { ...options, mcpServers } });
        assert.equal(yield* runner.allocateSessionId, "allocated-session");
        assert.deepEqual(launchOptions, options);
        assert.deepEqual(registered, mcpServers);
        assert.deepEqual(events[0], {
          direction: "outgoing",
          stage: "decoded",
          payload: { type: "query.open", options: { ...options, hasMcpServers: true } },
        });
        assert.isDefined(prompt);
        const iterator = prompt[Symbol.asyncIterator]();
        const message = makeClaudeUserMessage({ text: "hello" });
        yield* session.offer(message);
        assert.deepEqual(yield* Effect.promise(() => iterator.next()), {
          value: message,
          done: false,
        });
        yield* session.close;
        assert.isTrue(closed);
        assert.isTrue((yield* Effect.promise(() => iterator.next())).done);
      }),
  );

  it.effect("preserves incoming frames and records controls only after they succeed", () =>
    Effect.gen(function* () {
      const events: ClaudeAgentSdkProtocolLogEvent[] = [];
      const calls: unknown[] = [];
      const frame: SDKMessage = {
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "native-session",
      };
      const query = fakeQuery([frame]);
      query.stopTask = async (taskId) => {
        calls.push(taskId);
        if (taskId === "failed") throw new Error("stop rejected");
      };
      query.interrupt = async () => {
        calls.push("interrupted");
        return undefined;
      };
      const runner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        query: () => Effect.succeed(query),
        forkSession: async (sessionId) => ({ sessionId: `fork:${sessionId}` }),
        subagentLaunchToolUseId: async () => "parent-tool",
        protocolLogger: () => (event) => Effect.sync(() => void events.push(event)),
      });
      const session = yield* runner.open({ ...identity, options });
      yield* session.stopTask("running");
      const failed = yield* Effect.exit(session.stopTask("failed"));
      assert.isTrue(Exit.isFailure(failed));
      assert.deepEqual(
        events.map((event) => event.payload.type),
        ["query.open", "query.stop_task"],
      );
      yield* session.interrupt;
      assert.deepEqual(calls, ["running", "failed", "interrupted"]);
      assert.deepEqual(yield* Stream.runCollect(session.messages), [frame]);
      assert.deepEqual(
        yield* runner.forkSession({ ...identity, sessionId: "source", options: {} }),
        { sessionId: "fork:source" },
      );
      assert.equal(
        yield* runner.subagentLaunchToolUseId({
          ...identity,
          sessionId: "source",
          agentId: "child",
          dir: null,
        }),
        "parent-tool",
      );
      yield* session.close;
    }),
  );

  it.effect("stamps a decoded SDK iterator yield with only bounded frame identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const frame: SDKMessage = {
          type: "system",
          subtype: "status",
          status: "requesting",
          uuid: "00000000-0000-4000-8000-000000000011",
          session_id: "native-session-trace",
        };
        const oversizedId = "x".repeat(129);
        // Runtime SDK input can violate its UUID type, so tracing must cap this field anyway.
        const oversizedFrame = {
          type: "system",
          subtype: "status",
          status: "requesting",
          uuid: oversizedId,
          session_id: "native-session-trace",
        } as unknown as SDKMessage;
        const logs: string[] = [];
        const capture = Logger.map(Logger.formatJson, (line) => void logs.push(line));
        const runner = makeClaudeAgentSdkQueryRunner({
          allocateSessionId: Effect.succeed("allocated-session"),
          query: () => Effect.succeed(fakeQuery([frame, oversizedFrame])),
          forkSession: async () => ({ sessionId: "forked-session" }),
          subagentLaunchToolUseId: async () => null,
        });
        const session = yield* runner
          .open({ ...identity, options })
          .pipe(Effect.provideService(References.MinimumLogLevel, "Debug"));
        const received = yield* Stream.runCollect(session.messages).pipe(
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
        );
        const trace = claudeSdkFrameTraceFor(frame);

        assert.deepEqual(received, [frame, oversizedFrame]);
        assert.isDefined(trace);
        assert.equal(trace.streamOrdinal, 1);
        assert.equal(trace.nativeFrameId, frame.uuid);
        assert.equal(trace.nativeSessionId, frame.session_id);
        assert.include(logs.join("\n"), trace.traceId);
        assert.include(logs.join("\n"), "sdk.yield");
        assert.include(logs.join("\n"), "performance.now");
        assert.isUndefined(claudeSdkFrameTraceFor(oversizedFrame)?.nativeFrameId);
        assert.notInclude(logs.join("\n"), oversizedId);
        yield* session.close;
      }),
    ),
  );

  it.effect("keeps latency trace records out of the normal info log", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const frame: SDKMessage = {
          type: "system",
          subtype: "status",
          status: "requesting",
          uuid: "00000000-0000-4000-8000-000000000012",
          session_id: "native-session-info",
        };
        const logs: string[] = [];
        const capture = Logger.map(Logger.formatJson, (line) => void logs.push(line));
        const runner = makeClaudeAgentSdkQueryRunner({
          allocateSessionId: Effect.succeed("allocated-session"),
          query: () => Effect.succeed(fakeQuery([frame])),
          forkSession: async () => ({ sessionId: "forked-session" }),
          subagentLaunchToolUseId: async () => null,
        });
        const session = yield* runner
          .open({ ...identity, options })
          .pipe(Effect.provideService(References.MinimumLogLevel, "Info"));
        const received = yield* Stream.runCollect(session.messages).pipe(
          Effect.provideService(References.MinimumLogLevel, "Info"),
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
        );

        assert.deepEqual(received, [frame]);
        assert.isUndefined(claudeSdkFrameTraceFor(frame));
        assert.notInclude(logs.join("\n"), "orchestration-v2.provider-event-latency");
        yield* session.close;
      }),
    ),
  );

  it.effect("keeps launch preparation interruptible before acquiring the query", () =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      let acquired = false;
      const runner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        prepareQuery: () =>
          Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never)),
        query: () =>
          Effect.sync(() => {
            acquired = true;
            return fakeQuery();
          }),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const opening = yield* runner.open({ ...identity, options }).pipe(Effect.forkScoped);
      yield* Deferred.await(preparing);
      yield* Fiber.interrupt(opening);
      assert.isFalse(acquired);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves a query creation failure", () =>
    Effect.gen(function* () {
      const failure = new ClaudeAgentSdkQueryRunnerError({ method: "query", cause: "unavailable" });
      const runner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        query: () => Effect.fail(failure),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const result = yield* Effect.flip(runner.open({ ...identity, options }));
      assert.strictEqual(result, failure);
    }),
  );
});
