import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import type { CodexAdapterV2Options } from "@signalbox/provider-codex/runtime";
import { codexThreadRuntimeParams } from "@signalbox/provider-codex/threadConfig";
import { ThreadId } from "@t3tools/contracts";
import {
  ProviderAdapterProtocolError,
  ProviderAdapterInterruptError,
  ProviderAdapterTurnStartError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import {
  fixture,
  run,
  operations,
  targetThreadId,
  fallbackEndpoint,
} from "./tests/mcpConfigurationTestkit.ts";
import { fixture as recoveryFixture } from "./tests/nativeRecoveryTestkit.ts";

const modes = ["omitted", "undefined", "empty", "exact"] as const;
const cases = operations.flatMap((operation) => modes.map((mode) => ({ operation, mode })));
const isProtocolError = Schema.is(ProviderAdapterProtocolError);
const isTurnStartError = Schema.is(ProviderAdapterTurnStartError);
const isInterruptError = Schema.is(ProviderAdapterInterruptError);
const decodeConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    config: Schema.Struct({ mcp_servers: Schema.Record(Schema.String, Schema.Unknown) }),
  }),
);

describe("Codex MCP configuration callback", () => {
  it.effect.each(cases)("$operation uses $mode configuration", ({ operation, mode }) =>
    run(
      Effect.gen(function* () {
        const ids: (ThreadId | null)[] = [];
        const exact = {
          executor: { url: "http://executor.invalid/mcp" },
          other: { url: "http://other.invalid/mcp" },
        };
        const callback: CodexAdapterV2Options["mcpServers"] = (id) =>
          Effect.sync(() => {
            ids.push(id);
            return mode === "undefined" ? undefined : mode === "empty" ? {} : exact;
          });
        const f = yield* fixture(mode === "omitted" ? undefined : callback);
        yield* f.exercise(operation);
        const method =
          operation === "start"
            ? "thread/start"
            : operation === "fork"
              ? "thread/fork"
              : "thread/resume";
        const request = f.requests.find((r) => r.method === method);
        expect(request).toBeDefined();
        expect(request?.params).toMatchObject({
          config: {
            mcp_servers:
              mode === "empty"
                ? {}
                : mode === "exact"
                  ? exact
                  : {
                      "t3-code": {
                        url: fallbackEndpoint,
                        tool_timeout_sec: 3900,
                        http_headers: { Authorization: "Bearer fixture" },
                      },
                    },
          },
        });
        const config = yield* decodeConfig(request?.params);
        expect(Object.keys(config.config.mcp_servers)).toEqual(
          mode === "empty" ? [] : mode === "exact" ? ["executor", "other"] : ["t3-code"],
        );
        expect(ids).toEqual(
          mode === "omitted" ? [] : [operation === "fork" ? targetThreadId : f.turn.threadId],
        );
      }),
    ),
  );

  it.effect.each(operations)("%s fails typed before any native request", (operation) =>
    run(
      Effect.gen(function* () {
        const cause = new Error("MCP configuration unavailable");
        const f = yield* fixture(() => Effect.fail(cause));
        const error = yield* Effect.flip(f.exercise(operation));
        expect(error).toMatchObject({ cause: { _tag: "ProviderAdapterProtocolError" } });
        const protocol = error.cause;
        expect(isProtocolError(protocol)).toBe(true);
        if (isProtocolError(protocol)) expect(protocol.cause).toBe(cause);
        expect(f.requests).toEqual([]);
      }),
    ),
  );

  it.effect(
    "resolves the callback before initialization and passes null for a thread without an app ID",
    () =>
      run(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const available =
            yield* Deferred.make<Readonly<Record<string, { readonly url: string }>>>();
          const ids: (ThreadId | null)[] = [];
          const f = yield* fixture((id) =>
            Effect.gen(function* () {
              ids.push(id);
              yield* Deferred.succeed(entered, undefined);
              return yield* Deferred.await(available);
            }),
          );
          const fiber = yield* f.runtime
            .resumeThread({ providerThread: { ...f.turn.providerThread, appThreadId: null } })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          expect(f.requests).toEqual([]);
          yield* Deferred.succeed(available, {});
          yield* Fiber.join(fiber);
          expect(ids).toEqual([null]);
          expect(f.requests.map((r) => r.method)).toEqual(["initialize", "thread/resume"]);
        }),
      ),
  );

  it.effect("snapshots both the map and each server before returning native parameters", () =>
    Effect.sync(() => {
      const servers = { executor: { url: "http://original.invalid/mcp" } };
      const params = codexThreadRuntimeParams({ mcpSession: undefined, mcpServers: servers });
      servers.executor.url = "http://changed.invalid/mcp";
      Object.assign(servers, { later: { url: "http://later.invalid/mcp" } });
      expect(params.config.mcp_servers).toEqual({
        executor: { url: "http://original.invalid/mcp" },
      });
    }),
  );

  it.effect.each(["initialize", "thread/read"] as const)(
    "snapshots cold rollback configuration before the held %s request",
    (hold) =>
      run(
        Effect.gen(function* () {
          const executor = { url: "http://original.invalid/mcp" };
          const servers: Record<string, { url: string }> = {
            executor,
            removed: { url: "http://removed.invalid/mcp" },
          };
          const ids: (ThreadId | null)[] = [];
          const f = yield* fixture(
            (id) =>
              Effect.sync(() => {
                ids.push(id);
                return servers;
              }),
            { hold },
          );
          const rollback = yield* f
            .exercise("rollback")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* f.requestHeld;
          expect(f.requests.map((request) => request.method)).toEqual(
            hold === "initialize" ? ["initialize"] : ["initialize", "thread/read"],
          );
          executor.url = "http://changed.invalid/mcp";
          delete servers.removed;
          servers.added = { url: "http://added.invalid/mcp" };
          yield* f.releaseRequest;
          yield* Fiber.join(rollback);
          const resumed = f.requests.find((request) => request.method === "thread/resume");
          const config = yield* decodeConfig(resumed?.params);
          expect(config.config.mcp_servers).toEqual({
            executor: { url: "http://original.invalid/mcp" },
            removed: { url: "http://removed.invalid/mcp" },
          });
          expect(ids).toEqual([f.turn.threadId]);
        }),
      ),
  );

  it.effect(
    "keeps a successful native pause accurate when receipt persistence fails in flight",
    () => {
      const messages: string[] = [];
      return run(
        Effect.gen(function* () {
          const f = yield* recoveryFixture({
            earlyStart: true,
            delayGoalPause: true,
            delayAcceptanceReply: true,
            rejectReceipt: "native-accepted",
          });
          const starting = yield* f.runtime
            .startTurn(f.turn)
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(f.continued);
          const events = yield* f.readEvents;
          const started = events.find((e) => e.type === "provider_turn.updated");
          if (started?.type !== "provider_turn.updated")
            return yield* Effect.die("missing running turn");
          const interrupt = yield* f.runtime
            .interruptTurn({
              providerThread: f.turn.providerThread,
              providerTurnId: started.providerTurn.id,
            })
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* f.goalPauseRequested;
          yield* f.replyToStart;
          const startError = yield* Fiber.join(starting);
          expect(isTurnStartError(startError)).toBe(true);
          if (!isTurnStartError(startError)) return;
          yield* f.replyToGoalPause;
          const interruptError = yield* Fiber.join(interrupt);
          expect(isInterruptError(interruptError)).toBe(true);
          if (isInterruptError(interruptError)) expect(interruptError.cause).toBe(startError.cause);
          expect(messages.some((message) => message.includes("codex-goal-pause-failed"))).toBe(
            false,
          );
          expect(f.requests.map((r) => r.method)).toEqual(["turn/start", "thread/goal/set"]);
          expect(yield* f.readEvents).toEqual([]);
        }).pipe(
          Effect.provide(
            Logger.layer([Logger.make(({ message }) => messages.push(String(message)))], {
              mergeWithExisting: false,
            }),
          ),
        ),
      );
    },
  );
});
