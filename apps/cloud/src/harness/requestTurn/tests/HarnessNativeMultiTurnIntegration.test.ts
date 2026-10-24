import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { MessageId, RunAttemptId, RunId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import {
  completeNativeTurn,
  failedStartRows,
  integration,
  isNativeTurnStart,
  layer,
} from "./nativeLoadIntegrationFixture.ts";
import { runId, supervisor } from "../../runStore/tests/fixture.ts";
import { requestPublisher } from "../../runStore/tests/requestFixture.ts";

const decodeMcpConfiguration = Schema.decodeUnknownSync(
  Schema.Struct({
    threadId: Schema.optional(Schema.String),
    config: Schema.Struct({
      mcp_servers: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
    }),
  }),
);

describe("request-turn native load through the real Codex binding", () => {
  it.effect("reuses one binding for the next ordinary turn with a fresh MCP route epoch", () =>
    Effect.gen(function* () {
      const firstStart = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      const secondStart = Promise.withResolvers<void>();
      const firstStartPublished = yield* Deferred.make<void>();
      const secondStartPublished = yield* Deferred.make<void>();
      let starts = 0;
      let publishedStarts = 0;
      const requestId = "native-load-turn-2";
      const calibrated = yield* integration("thread/start", async (method) => {
        if (method === "thread/resume") resumed.resolve();
        if (method === "turn/start") {
          starts++;
          if (starts === 1) firstStart.resolve();
          if (starts === 2) secondStart.resolve();
        }
      });
      calibrated.driver.setPublication((item) => {
        if (item.kind !== "provider" || !isNativeTurnStart(item.event)) return Effect.void;
        publishedStarts++;
        return Deferred.succeed(
          publishedStarts === 1 ? firstStartPublished : secondStartPublished,
          undefined,
        );
      });
      const firstRun = yield* calibrated.run.pipe(Effect.result, Effect.forkScoped);
      const reachedFirstStart = yield* Effect.raceFirst(
        Effect.promise(() => firstStart.promise).pipe(Effect.as("turn/start")),
        Fiber.await(firstRun).pipe(Effect.as("request-ended")),
      );
      expect(reachedFirstStart, JSON.stringify(failedStartRows(calibrated.driver))).toBe(
        "turn/start",
      );
      const firstWasPublished = yield* Effect.raceFirst(
        Deferred.await(firstStartPublished).pipe(Effect.as("published")),
        Fiber.await(firstRun).pipe(Effect.as("request-ended")),
      );
      if (firstWasPublished === "request-ended") {
        const outcome = yield* Fiber.join(firstRun);
        if (Result.isFailure(outcome)) return yield* Effect.fail(outcome.failure);
        return yield* Effect.die("First request ended before its native start was published");
      }
      const firstNativeStart = calibrated.peer.requests.find(
        (item) => item.method === "thread/start",
      );
      if (firstNativeStart?.params === undefined)
        return yield* Effect.die("Codex thread/start omitted its native MCP configuration");
      const firstUrl = decodeMcpConfiguration(firstNativeStart.params).config.mcp_servers.executor
        ?.url;
      if (firstUrl === undefined)
        return yield* Effect.die("Codex executor route was not installed");

      yield* completeNativeTurn(calibrated.peer, "preinitialized-turn");
      const first = yield* Fiber.join(firstRun);
      if (Result.isFailure(first)) return yield* Effect.fail(first.failure);
      expect(first.success.action).toBe("committed");
      expect(first.success.snapshot.requests?.entries[0]?.finish?.status).toBe("completed");
      expect(calibrated.driver.exports).toHaveLength(1);
      const providerThread = calibrated.driver.exports[0]?.snapshot.providerThread;
      expect(providerThread?.nativeThreadRef).toMatchObject({
        nativeId: "preinitialized-native-thread",
        strength: "strong",
      });
      if (providerThread === undefined)
        return yield* Effect.die("First request did not checkpoint its native Codex thread");

      const base = calibrated.driver.instance.adapter.turn;
      const nextTurn = {
        ...base,
        runId: RunId.make("native-load-run-2"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("native-load-attempt-2"),
        providerThread,
        message: {
          ...base.message,
          messageId: MessageId.make("native-load-message-2"),
          text: "second ordinary turn",
        },
      };
      const input = yield* calibrated.driver.input("native-load-input-2", nextTurn);
      yield* calibrated.call({
        type: "request.offer",
        runId,
        supervisor,
        request: { requestId, input },
      });
      const secondRun = yield* calibrated.facet
        .run({ publisher: requestPublisher(), requestId })
        .pipe(Effect.result, Effect.forkScoped);
      const reachedResume = yield* Effect.raceFirst(
        Effect.promise(() => resumed.promise).pipe(Effect.as("thread/resume")),
        Fiber.await(secondRun).pipe(Effect.as("request-ended")),
      );
      const failuresBeforeResume = failedStartRows(calibrated.driver);
      expect(reachedResume, JSON.stringify(failuresBeforeResume)).toBe("thread/resume");
      expect(failuresBeforeResume).toEqual([]);
      const reachedSecondStart = yield* Effect.raceFirst(
        Effect.promise(() => secondStart.promise).pipe(Effect.as("turn/start")),
        Fiber.await(secondRun).pipe(Effect.as("request-ended")),
      );
      expect(
        reachedSecondStart,
        JSON.stringify({
          failures: failedStartRows(calibrated.driver),
          bindingCalls: calibrated.bindingCalls,
          providerStart: calibrated.providerStartInputs.at(-1),
        }),
      ).toBe("turn/start");
      const secondWasPublished = yield* Effect.raceFirst(
        Deferred.await(secondStartPublished).pipe(Effect.as("published")),
        Fiber.await(secondRun).pipe(Effect.as("request-ended")),
      );
      if (secondWasPublished === "request-ended") {
        const outcome = yield* Fiber.join(secondRun);
        if (Result.isFailure(outcome)) return yield* Effect.fail(outcome.failure);
        return yield* Effect.die("Second request ended before its native start was published");
      }

      const resume = calibrated.peer.requests.find((item) => item.method === "thread/resume");
      if (resume?.params === undefined)
        return yield* Effect.die("Ordinary second turn omitted Codex thread/resume");
      const resumedConfiguration = decodeMcpConfiguration(resume.params);
      const secondUrl = resumedConfiguration.config.mcp_servers.executor?.url;
      if (secondUrl === undefined)
        return yield* Effect.die("Second executor route was not installed");
      expect(secondUrl).not.toBe(firstUrl);
      expect(resumedConfiguration.threadId).toBe("preinitialized-native-thread");

      const oldRoute = yield* Effect.tryPromise({
        try: () => calibrated.modelTransport(new Request(firstUrl)),
        catch: (cause) => new HarnessRequestFacetError("Stale MCP route was rejected.", { cause }),
      }).pipe(Effect.result);
      expect(Result.isFailure(oldRoute)).toBe(true);
      const currentRoute = yield* Effect.tryPromise({
        try: () => calibrated.modelTransport(new Request(secondUrl)),
        catch: (cause) =>
          new HarnessRequestFacetError("Current MCP route was rejected.", { cause }),
      });
      expect(yield* Effect.promise(() => currentRoute.text())).toBe("executor");
      expect(calibrated.driver.f.forwards.at(-1)?.grant.secret).toBe(requestId);

      yield* completeNativeTurn(calibrated.peer, "preinitialized-turn");
      const second = yield* Fiber.join(secondRun);
      if (Result.isFailure(second)) return yield* Effect.fail(second.failure);
      expect(second.success.action).toBe("committed");
      expect(
        second.success.snapshot.requests?.entries.map((entry) => entry.finish?.status),
      ).toEqual(["completed", "completed"]);
      expect(calibrated.driver.exports).toHaveLength(2);
      expect(calibrated.driver.terminals).toHaveLength(2);
      expect(calibrated.providerStartInputs).toHaveLength(2);
      expect(calibrated.providerStartInputs[1]).toEqual(calibrated.providerStartInputs[0]);
      expect(calibrated.bindingConstructions).toBe(1);
      expect(calibrated.configurations.map((item) => item.epoch)).toEqual([1, 2]);
      expect(calibrated.configurationLoads.map((item) => item.method)).toEqual([
        "ensureThread",
        "resumeThread",
      ]);
      expect(calibrated.bindingCalls).toEqual(["ensureThread", "startTurn", "startTurn"]);
      expect(calibrated.peer.sent.filter((method) => method !== "thread/read")).toEqual([
        "thread/start",
        "turn/start",
        "thread/resume",
        "turn/start",
      ]);
      expect(calibrated.launchCount).toBe(1);
      expect(failedStartRows(calibrated.driver)).toEqual([]);
      yield* calibrated.facet.dispose;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
