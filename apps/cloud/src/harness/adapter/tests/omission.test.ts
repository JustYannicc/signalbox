import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { fixtureForDriver } from "./fixture.ts";

const omission = {
  code: "RELEASE_MODULE_OMITTED",
  inputPath: "bun-graph:/modules/shutdown.js",
  tier: "corpus",
} as const;

describe.each(["codex", "claudeAgent"])("%s release omission completion", (driver) => {
  it.effect("emits exactly one correlated typed failed terminal for an active omission", () =>
    Effect.gen(function* () {
      const f = yield* fixtureForDriver(ProviderDriverKind.make(driver));
      const opened = yield* f.open();
      yield* opened.session.turn(f.turn);
      yield* opened.next;
      yield* opened.next;
      yield* f.named();
      yield* opened.next;
      f.reportReleaseModuleOmitted(omission);
      f.reportReleaseModuleOmitted(omission);
      yield* f.terminal();
      yield* f.endEvents;
      expect(Exit.isFailure(yield* Fiber.join(opened.collector))).toBe(true);
      const terminals = opened.events.filter(
        (item) => item.kind === "provider" && item.event.type === "turn.terminal",
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        kind: "provider",
        runId: f.turn.runId,
        event: {
          type: "turn.terminal",
          driver,
          providerThreadId: f.turn.providerThread.id,
          providerTurnId: f.native().id,
          runOrdinal: f.turn.runOrdinal,
          status: "failed",
          failure: {
            code: omission.code,
          },
        },
      });
      expect(f.calls).not.toContain("save");
      const trace = opened.events.find((item) => item.kind === "log");
      expect(trace?.kind === "log" ? JSON.parse(trace.message) : undefined).toMatchObject({
        _tag: "ReleaseModuleOmittedFailure",
        ...omission,
        stack: expect.any(String),
      });
      expect(Result.isFailure(yield* opened.session.export().pipe(Effect.result))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("correlates omission failure before the provider has named its native turn", () =>
    Effect.gen(function* () {
      const f = yield* fixtureForDriver(ProviderDriverKind.make(driver));
      const gate = yield* Deferred.make<void>();
      f.setStartGate(Deferred.await(gate));
      const opened = yield* f.open();
      const starting = yield* opened.session.turn(f.turn).pipe(Effect.exit, Effect.forkScoped);
      yield* f.nextStart;
      f.reportReleaseModuleOmitted(omission);
      expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
      yield* Fiber.join(opened.collector);
      const failedTurn = opened.events.find(
        (item) => item.kind === "provider" && item.event.type === "provider_turn.updated",
      );
      const terminals = opened.events.filter(
        (item) => item.kind === "provider" && item.event.type === "turn.terminal",
      );
      expect(failedTurn).toMatchObject({
        event: {
          providerTurn: {
            runAttemptId: f.turn.attemptId,
            nodeId: f.turn.rootNodeId,
            status: "failed",
            nativeTurnRef: null,
          },
        },
      });
      expect(terminals).toHaveLength(1);
      if (failedTurn?.kind !== "provider") throw new Error("Missing failed provider turn");
      const providerTurn = failedTurn.event.providerTurn;
      if (providerTurn === null || typeof providerTurn !== "object")
        throw new Error("Missing failed provider turn row");
      expect(terminals[0]).toMatchObject({
        runId: f.turn.runId,
        event: {
          providerTurnId: Reflect.get(providerTurn, "id"),
          status: "failed",
          failure: { code: omission.code },
        },
      });
      expect(f.calls).not.toContain("save");
    }).pipe(Effect.scoped),
  );

  it.effect("fails shutdown while preserving terminals and checkpoints published earlier", () =>
    Effect.gen(function* () {
      const f = yield* fixtureForDriver(ProviderDriverKind.make(driver));
      f.setCleanup(Effect.sync(() => f.reportReleaseModuleOmitted(omission)));
      const opened = yield* f.open();
      yield* opened.session.turn(f.turn);
      yield* opened.next;
      yield* opened.next;
      yield* f.terminal();
      yield* opened.next;
      yield* opened.next;
      const checkpoint = yield* opened.session.export();
      expect(checkpoint.snapshot.providerTurns[0]?.status).toBe("completed");
      const saves = f.calls.filter((call) => call === "saved").length;
      const disposed = yield* opened.session.dispose.pipe(Effect.result);
      expect(Result.isFailure(disposed)).toBe(true);
      expect(JSON.stringify(disposed)).toContain("ReleaseModuleOmittedFailure");
      expect(Exit.isFailure(yield* Fiber.join(opened.collector))).toBe(true);
      expect(
        opened.events.filter(
          (item) => item.kind === "provider" && item.event.type === "turn.terminal",
        ),
      ).toMatchObject([{ event: { status: "completed" } }]);
      expect(f.calls.filter((call) => call === "saved")).toHaveLength(saves);
      expect(Result.isFailure(yield* opened.session.export().pipe(Effect.result))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("fails an active turn when shutdown reaches an omitted module", () =>
    Effect.gen(function* () {
      const f = yield* fixtureForDriver(ProviderDriverKind.make(driver));
      f.setCleanup(Effect.sync(() => f.reportReleaseModuleOmitted(omission)));
      const opened = yield* f.open();
      yield* opened.session.turn(f.turn);
      yield* opened.next;
      yield* opened.next;
      yield* f.named();
      yield* opened.next;
      expect(Result.isFailure(yield* opened.session.dispose.pipe(Effect.result))).toBe(true);
      yield* Fiber.join(opened.collector);
      expect(
        opened.events.filter(
          (item) => item.kind === "provider" && item.event.type === "turn.terminal",
        ),
      ).toMatchObject([{ event: { status: "failed", failure: { code: omission.code } } }]);
      expect(f.calls).not.toContain("save");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a pending terminal and cancels its save when shutdown omits a module", () =>
    Effect.gen(function* () {
      const f = yield* fixtureForDriver(ProviderDriverKind.make(driver));
      const gate = Promise.withResolvers<void>();
      f.setSaveGate(gate.promise);
      f.setCleanup(
        Effect.sync(() => {
          f.reportReleaseModuleOmitted(omission);
          gate.resolve();
        }),
      );
      const opened = yield* f.open();
      yield* opened.session.turn(f.turn);
      yield* opened.next;
      yield* opened.next;
      yield* f.named();
      yield* opened.next;
      yield* f.terminal();
      yield* opened.next;
      yield* f.saving;
      expect(Result.isFailure(yield* opened.session.dispose.pipe(Effect.result))).toBe(true);
      yield* Fiber.join(opened.collector);
      expect(f.calls).not.toContain("saved");
      expect(
        opened.events.filter(
          (item) => item.kind === "provider" && item.event.type === "turn.terminal",
        ),
      ).toMatchObject([{ event: { status: "failed", failure: { code: omission.code } } }]);
      expect(Result.isFailure(yield* opened.session.export().pipe(Effect.result))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a pending checkpoint save after a previously published terminal", () =>
    Effect.gen(function* () {
      const f = yield* fixtureForDriver(ProviderDriverKind.make(driver));
      const opened = yield* f.open();
      yield* opened.session.turn(f.turn);
      yield* opened.next;
      yield* opened.next;
      yield* f.terminal();
      yield* opened.next;
      yield* opened.next;
      const gate = Promise.withResolvers<void>();
      f.setSaveGate(gate.promise);
      const exporting = yield* opened.session.export().pipe(Effect.result, Effect.forkScoped);
      yield* f.saving;
      f.reportReleaseModuleOmitted(omission);
      gate.resolve();
      expect(Result.isFailure(yield* Fiber.join(exporting))).toBe(true);
      yield* Fiber.join(opened.collector);
      expect(f.calls.filter((call) => call === "saved")).toHaveLength(1);
      expect(f.calls).not.toContain("snapshot");
      expect(
        opened.events.filter(
          (item) => item.kind === "provider" && item.event.type === "turn.terminal",
        ),
      ).toMatchObject([{ event: { status: "completed" } }]);
    }).pipe(Effect.scoped),
  );
});
