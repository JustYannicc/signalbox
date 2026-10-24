import { describe, expect, it, vi } from "@effect/vitest";
import { RuntimeRequestId } from "@t3tools/contracts";
import {
  providerEventLatencyClock,
  rememberProviderEventLatencyTrace,
} from "@t3tools/provider-core/server/ProviderEventLatencyTrace";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";

import { fixture } from "./fixture.ts";

const traceId = "consumer-step-test";
type Fields = Readonly<Record<string, unknown>>;

const traced = Effect.gen(function* () {
  const f = yield* fixture;
  const opened = yield* f.open();
  yield* opened.session.turn(f.turn);
  yield* opened.next;
  yield* opened.next;
  const event = {
    type: "provider_turn.updated" as const,
    driver: f.runtime.driver,
    providerTurn: f.native(),
  };
  rememberProviderEventLatencyTrace(event, {
    traceId,
    streamId: "consumer-step-stream",
    streamOrdinal: 27,
    eventType: event.type,
    createdAtMs: providerEventLatencyClock.nowMs(),
  });
  return { ...f, ...opened, event };
});

function capture(logs: Fields[]) {
  return Logger.layer(
    [
      Logger.map(Logger.formatJson, (line) => {
        const { message }: { message?: unknown } = JSON.parse(line);
        if (!Array.isArray(message) || message[0] !== "orchestration-v2.provider-event-latency")
          return;
        const fields: unknown = message[1];
        if (typeof fields !== "object" || fields === null || !("traceId" in fields)) return;
        if (fields.traceId === traceId) {
          logs.push(fields);
        }
      }),
    ],
    { mergeWithExisting: false },
  );
}

describe("AdapterHarness consumer trace", () => {
  it.effect(
    "records consumer phases without persisting a running update or adding log calls",
    () => {
      const logs: Fields[] = [];
      const clock = vi.spyOn(providerEventLatencyClock, "nowMs").mockReturnValue(10);
      return Effect.gen(function* () {
        const f = yield* traced;
        f.setSnapshotFailure();
        f.setSaveFailure(new Error("A running turn update must not persist files."));
        yield* f.emit(f.event);
        const forwarded = yield* f.next;
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          stage: "runner.host-forward",
          traceId,
          runId: f.turn.runId,
          streamOrdinal: 27,
          eventType: "provider_turn.updated",
          consumer: {
            enteredAtMs: 10,
            beganReadyAtMs: 10,
            lockAcquiredAtMs: 10,
            applyInterruptStartedAtMs: 10,
            applyInterruptCompletedAtMs: 10,
            publishStartedAtMs: 10,
            encodedAtMs: 10,
            interruptRequested: false,
            interruptApplied: false,
          },
        });
        expect(f.calls).not.toContain("snapshot");
        expect(f.calls).not.toContain("save");
        expect(f.controls).toEqual([]);
        expect(JSON.stringify(forwarded)).not.toContain(traceId);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.sync(() => clock.mockRestore())),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(capture(logs)),
      );
    },
  );

  it.effect("isolates time spent applying a pending interrupt", () => {
    const logs: Fields[] = [];
    const clock = vi.spyOn(providerEventLatencyClock, "nowMs").mockReturnValue(10);
    return Effect.gen(function* () {
      const f = yield* traced;
      const release = yield* Deferred.make<void>();
      f.setInterruptEffect(Deferred.await(release));
      yield* f.session.control({
        type: "interrupt",
        runId: f.turn.runId,
        preparationGeneration: f.turn.preparationGeneration,
      });
      yield* f.emit(f.event);
      yield* f.nextInterrupt;
      expect(logs).toEqual([]);
      expect(f.events.filter((item) => item.kind === "provider")).toHaveLength(1);
      clock.mockReturnValue(100);
      yield* Deferred.succeed(release, undefined);
      const forwarded = yield* f.next;
      expect(forwarded.kind === "provider" && forwarded.event.type).toBe("provider_turn.updated");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        stage: "runner.host-forward",
        monotonicMs: 100,
        consumer: {
          enteredAtMs: 10,
          beganReadyAtMs: 10,
          lockAcquiredAtMs: 10,
          applyInterruptStartedAtMs: 10,
          applyInterruptCompletedAtMs: 100,
          publishStartedAtMs: 100,
          encodedAtMs: 100,
          interruptRequested: true,
          interruptApplied: false,
        },
      });
      expect(f.controls).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(Effect.sync(() => clock.mockRestore())),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(capture(logs)),
    );
  });

  it.effect("separates a shared-lock wait from handling the provider event", () =>
    Effect.gen(function* () {
      const logs: Fields[] = [];
      const samples = yield* Queue.unbounded<void>();
      const clock = vi.spyOn(providerEventLatencyClock, "nowMs").mockReturnValue(10);
      yield* Effect.gen(function* () {
        const f = yield* traced;
        yield* f.named();
        yield* f.next;
        const requestId = RuntimeRequestId.make("held-response");
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          threadId: f.turn.threadId,
          runtimeRequest: {
            id: requestId,
            nodeId: f.turn.rootNodeId,
            providerTurnId: f.native().id,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: f.runtime.providerSessionId },
            createdAt: f.native().startedAt!,
            resolvedAt: null,
          },
        });
        yield* f.next;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setResponseEffect(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const responding = yield* f.session
          .control({
            type: "runtime-request.respond",
            runId: f.turn.runId,
            attemptId: f.turn.attemptId,
            providerSessionId: f.runtime.providerSessionId,
            requestId,
            decision: "accept",
            answers: undefined,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        clock.mockImplementation(() => {
          Queue.offerUnsafe(samples, undefined);
          return 10;
        });
        yield* f.emit(f.event);
        // Entry and began-ready are sampled before the held semaphore can be acquired.
        yield* Queue.take(samples);
        yield* Queue.take(samples);
        expect(logs).toEqual([]);
        clock.mockReturnValue(100);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(responding);
        yield* f.next;
        const forwarded = yield* f.next;
        expect(forwarded.kind === "provider" && forwarded.event.type).toBe("provider_turn.updated");
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          stage: "runner.host-forward",
          monotonicMs: 100,
          consumer: {
            enteredAtMs: 10,
            beganReadyAtMs: 10,
            lockAcquiredAtMs: 100,
            applyInterruptStartedAtMs: 100,
            applyInterruptCompletedAtMs: 100,
            publishStartedAtMs: 100,
            encodedAtMs: 100,
          },
        });
      }).pipe(
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(capture(logs)),
        Effect.ensuring(Effect.sync(() => clock.mockRestore())),
      );
    }).pipe(Effect.scoped),
  );
});
