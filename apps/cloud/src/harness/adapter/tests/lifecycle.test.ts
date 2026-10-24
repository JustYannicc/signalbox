import { describe, expect, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2Event as ProviderAdapterV2EventModel,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  providerEventLatencyClock,
  rememberProviderEventLatencyTrace,
} from "@t3tools/provider-core/server/ProviderEventLatencyTrace";

import { fixture } from "./fixture.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(ProviderAdapterV2Event));

const running = Effect.gen(function* () {
  const f = yield* fixture;
  const opened = yield* f.open();
  yield* opened.session.turn(f.turn);
  expect((yield* opened.next).kind).toBe("turn.started");
  expect((yield* opened.next).kind).toBe("provider");
  return { ...f, ...opened };
});

const finish = (f: Effect.Success<typeof running>) =>
  Effect.gen(function* () {
    yield* f.terminal();
    yield* f.next;
    const terminal = yield* f.next;
    expect(terminal.kind === "provider" && terminal.event.type).toBe("turn.terminal");
  });

describe("AdapterHarness lifecycle", () => {
  it.effect("fails an active turn after a release module is omitted", () =>
    Effect.gen(function* () {
      const f = yield* running;
      const event = {
        code: "RELEASE_MODULE_OMITTED",
        inputPath: "bun-graph:/chunks/lazy.js",
        tier: "configuration",
      } as const;
      f.reportReleaseModuleOmitted(event);
      expect((yield* f.next).kind).toBe("log");
      yield* f.terminal();
      yield* f.endEvents;
      const collector = yield* Fiber.join(f.collector);
      expect(Exit.isFailure(collector)).toBe(true);
      expect(
        f.events.filter((item) => item.kind === "provider" && item.event.type === "turn.terminal"),
      ).toMatchObject([{ event: { status: "failed", failure: { code: event.code } } }]);
      expect(f.calls).not.toContain("save");
      expect(Result.isFailure(yield* f.session.export().pipe(Effect.result))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "passes host inputs through and publishes started before provider JSON, saving before terminal",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        expect(f.opened[0]?.computer).toBe(f.input.computer);
        expect(f.opened[0]?.modelTransport).toBe(f.input.modelTransport);
        expect(f.opened[0]?.hooks).toBe(f.input.hooks);
        expect(f.opened[0]?.release).toBe(f.input.release);
        yield* f.named();
        const item = yield* f.next;
        expect(item.kind).toBe("provider");
        if (item.kind !== "provider") throw new Error("Expected provider event");
        expect(item.event).toMatchObject({
          type: "provider_turn.updated",
          providerTurn: { startedAt: DateTime.formatIso(f.native().startedAt!) },
        });
        expect(decodeEvent(item.event)).toEqual({
          type: "provider_turn.updated",
          driver: f.runtime.driver,
          providerTurn: f.native(),
        });
        const saved = Promise.withResolvers<void>();
        f.setSaveGate(saved.promise);
        yield* f.terminal();
        yield* f.next;
        yield* f.saving;
        expect(
          f.events.some(
            (event) => event.kind === "provider" && event.event.type === "turn.terminal",
          ),
        ).toBe(false);
        expect(f.calls).not.toContain("snapshot");
        saved.resolve();
        yield* f.next;
        expect(f.calls.indexOf("save")).toBeLessThan(f.calls.indexOf("publish:turn.terminal"));
        expect(f.calls).not.toContain("snapshot");
        expect(f.events.some((event) => event.kind === "drive.checkpoint")).toBe(false);
        const checkpoint = yield* f.session.export();
        expect(checkpoint.revision).toEqual({ commit: "computer-revision" });
        expect(checkpoint.snapshot.providerTurns[0]?.status).toBe("completed");
        expect(f.calls.filter((call) => call === "save")).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect("forwards trailing session events without completing or saving the turn twice", () =>
    Effect.gen(function* () {
      const f = yield* running;
      yield* finish(f);
      yield* f.emit({
        type: "turn.terminal",
        driver: f.runtime.driver,
        providerThreadId: f.turn.providerThread.id,
        providerTurnId: f.native().id,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* f.emit({
        type: "provider_session.updated",
        driver: f.runtime.driver,
        providerSession: f.runtime.providerSession,
      });
      const trailing = yield* f.next;
      expect(trailing.kind === "provider" && trailing.event.type).toBe("provider_session.updated");
      expect(f.calls.filter((call) => call === "save")).toHaveLength(1);
      expect(
        Result.isFailure(
          yield* f.session
            .control({ type: "interrupt", runId: f.turn.runId, preparationGeneration: 1 })
            .pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("logs host forwarding through the out-of-band event trace", () => {
    const logs: string[] = [];
    const capture = Logger.map(Logger.formatJson, (line) => void logs.push(line));
    const traceId = "provider-event-trace:host-forward";
    return Effect.scoped(
      Effect.gen(function* () {
        const f = yield* running;
        yield* finish(f);
        const event: ProviderAdapterV2EventModel = {
          type: "provider_session.updated",
          driver: f.runtime.driver,
          providerSession: f.runtime.providerSession,
        };
        rememberProviderEventLatencyTrace(event, {
          traceId,
          streamId: "provider-session:test-host-forward",
          streamOrdinal: 1,
          eventType: event.type,
          entityId: event.providerSession.id,
          createdAtMs: providerEventLatencyClock.nowMs(),
        });
        yield* f.emit(event);
        const forwarded = yield* f.next;

        expect(forwarded.kind).toBe("provider");
        expect(JSON.stringify(forwarded)).not.toContain(traceId);
        expect(logs.join("\n")).toContain("runner.host-forward");
        expect(logs.join("\n")).toContain(traceId);
      }).pipe(
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect(
    "shares concurrent duplicate starts, rejects conflicts and allows only one active turn",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const gate = yield* Deferred.make<void>();
        f.setStartGate(Deferred.await(gate));
        const { session } = yield* f.open();
        const first = yield* session.turn(f.turn).pipe(Effect.forkScoped);
        yield* f.nextStart;
        const duplicate = yield* session.turn(f.turn).pipe(Effect.forkScoped);
        expect(
          Result.isFailure(
            yield* session
              .turn({ ...f.turn, attemptId: RunAttemptId.make("other") })
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* session
              .turn({ ...f.turn, runId: RunId.make("other"), runOrdinal: 2 })
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(Result.isFailure(yield* session.export().pipe(Effect.result))).toBe(true);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(duplicate);
        expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "remembers recent completed starts and rejects evicted old ordinals instead of running them again",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const { session, next } = yield* f.open();
        for (let ordinal = 1; ordinal <= 130; ordinal++) {
          const turn = {
            ...f.turn,
            runId: RunId.make(`run-${ordinal}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: RunAttemptId.make(`attempt-${ordinal}`),
          };
          yield* session.turn(turn);
          yield* next;
          if (ordinal === 1) yield* next;
          yield* f.terminal(turn);
          yield* next;
          yield* next;
          yield* session.turn(turn);
        }
        expect(Result.isFailure(yield* session.turn(f.turn).pipe(Effect.result))).toBe(true);
        expect(f.calls.filter((call) => call === "start")).toHaveLength(130);
      }).pipe(Effect.scoped),
  );

  it.effect("withholds terminal and fails the event stream when Computer save fails", () =>
    Effect.gen(function* () {
      const f = yield* running;
      f.setSaveFailure(new Error("storage offline"));
      yield* f.terminal();
      expect(Exit.isFailure(yield* Fiber.join(f.collector))).toBe(true);
      expect(
        f.events.some((event) => event.kind === "provider" && event.event.type === "turn.terminal"),
      ).toBe(false);
      expect(Result.isFailure(yield* f.session.export().pipe(Effect.result))).toBe(true);
      expect(
        Result.isFailure(
          yield* f.session
            .turn({ ...f.turn, runId: RunId.make("next"), runOrdinal: 2 })
            .pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "resumes an exported native checkpoint without injecting history or creating a thread",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        yield* finish(f);
        const checkpoint = yield* f.session.export();
        yield* f.session.dispose;
        const resumed = yield* f.open({
          ...f.input,
          checkpoint: structuredCloneCheckpoint(checkpoint),
        });
        expect(f.opened[1]?.session.resumeFromSession).toEqual(checkpoint.providerSession);
        expect(f.opened[1]?.session.initialNativeThreadId).toBe("native-thread");
        expect(f.calls.filter((call) => call === "resume")).toHaveLength(1);
        expect(f.calls.filter((call) => call === "ensure")).toHaveLength(1);
        expect((yield* resumed.session.export()).snapshot).toEqual(checkpoint.snapshot);
        const mismatches = [
          { ...checkpoint, release: { ...checkpoint.release, version: "other" } },
          {
            ...checkpoint,
            release: { ...checkpoint.release, modules: { entry: { bytes: 2, sha256: "entry" } } },
          },
          {
            ...checkpoint,
            snapshot: {
              ...checkpoint.snapshot,
              providerThread: { ...checkpoint.snapshot.providerThread, appThreadId: null },
            },
          },
        ];
        for (const invalid of mismatches) {
          expect(
            Result.isFailure(
              yield* f.service.open({ ...f.input, checkpoint: invalid }).pipe(Effect.result),
            ),
          ).toBe(true);
        }
        expect(f.opened).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect("awaits scoped runtime cleanup on concurrent disposal and rejects later work", () =>
    Effect.gen(function* () {
      const f = yield* running;
      const cleaning = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setCleanup(
        Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const first = yield* f.session.dispose.pipe(Effect.forkScoped);
      yield* Deferred.await(cleaning);
      const second = yield* f.session.dispose.pipe(Effect.forkScoped);
      expect(f.calls).not.toContain("cleanup:end");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(f.calls.filter((call) => call === "cleanup:end")).toHaveLength(1);
      expect(Result.isFailure(yield* f.session.turn(f.turn).pipe(Effect.result))).toBe(true);
      expect(Exit.isSuccess(yield* Fiber.join(f.collector))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

const structuredCloneCheckpoint = (checkpoint: import("../../Harness.ts").HarnessCheckpoint) => ({
  ...checkpoint,
  release: { ...checkpoint.release, modules: { ...checkpoint.release.modules } },
  snapshot: {
    ...checkpoint.snapshot,
    providerThread: {
      ...checkpoint.snapshot.providerThread,
      nativeThreadRef:
        checkpoint.snapshot.providerThread.nativeThreadRef === null
          ? null
          : { ...checkpoint.snapshot.providerThread.nativeThreadRef },
    },
  },
});
