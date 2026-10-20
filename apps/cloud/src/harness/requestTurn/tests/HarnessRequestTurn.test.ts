import { describe, expect, it } from "@effect/vitest";
import { ProviderTurnId, TurnItemId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { createHarnessRequestTurn } from "../../HarnessRequestTurn.ts";
import { requestFixture } from "./fixture.ts";

describe("HarnessRequestTurn", () => {
  it.effect("restores before native open and waits for terminal publication before exporting", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const publishing = yield* Deferred.make<void>();
      const published = yield* Deferred.make<void>();
      f.setPublication((item) =>
        item.kind === "provider" && item.event.type === "turn.terminal"
          ? Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Deferred.await(published)))
          : Effect.void,
      );
      const context = f.context("request-1");
      const runtime = yield* f.open(context);
      const running = yield* runtime.run(f.firstInput, context).pipe(Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      expect(f.order).toEqual(["restore", "native-open"]);
      expect(f.exports).toHaveLength(0);
      yield* f.instance.adapter.terminal();
      yield* Deferred.await(publishing);
      expect(f.exports).toHaveLength(0);
      yield* Deferred.succeed(published, undefined);
      const finished = yield* Fiber.join(running);
      expect(finished.status).toBe("completed");
      expect(f.exports).toHaveLength(1);
      expect(f.exports[0]?.revision).toEqual({ commit: "computer-revision" });
      expect(f.terminals[0]?.event.type).toBe("turn.terminal");
      expect(f.progress.every((id) => id === "request-1")).toBe(true);
      yield* f.verify(finished.result, "result");
      yield* f.verify(finished.checkpoint.native, "native");
      yield* f.verify(finished.checkpoint.filesystem, "filesystem");
    }).pipe(Effect.scoped),
  );

  it.effect("ignores another native turn's terminal and preserves an interrupted terminal", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const observed = yield* Deferred.make<void>();
      f.setPublication((item) =>
        item.kind === "provider" && item.event.type === "command_output.delta"
          ? Deferred.succeed(observed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const context = f.context("request-1");
      const runtime = yield* f.open(context);
      const running = yield* runtime.run(f.firstInput, context).pipe(Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* f.instance.adapter.named();
      yield* f.instance.adapter.emit({
        type: "turn.terminal",
        driver: f.instance.adapter.runtime.driver,
        providerThreadId: f.instance.adapter.turn.providerThread.id,
        providerTurnId: ProviderTurnId.make("other"),
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* f.instance.adapter.emit({
        type: "command_output.delta",
        driver: f.instance.adapter.runtime.driver,
        threadId: f.instance.adapter.turn.threadId,
        itemId: TurnItemId.make("command"),
        chunk: "marker",
      });
      yield* Deferred.await(observed);
      expect(f.exports).toHaveLength(0);
      yield* f.instance.adapter.emit({
        type: "turn.terminal",
        driver: f.instance.adapter.runtime.driver,
        providerThreadId: f.instance.adapter.turn.providerThread.id,
        providerTurnId: f.instance.adapter.native().id,
        runOrdinal: 1,
        status: "interrupted",
        failure: null,
        threadDisposition: "reusable",
      });
      const result = yield* Fiber.join(running);
      expect(result.status).toBe("failed");
      expect(f.terminals[0]?.event.status).toBe("interrupted");
      expect(f.terminals[0]?.event.failure).toBe(null);
    }).pipe(Effect.scoped),
  );

  it.effect("fails publication without producing a checkpoint result", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      f.setPublication((item) =>
        item.kind === "provider" && item.event.type === "turn.terminal"
          ? Effect.fail(new HarnessRequestFacetError("Durable event publication failed"))
          : Effect.void,
      );
      const context = f.context("request-1");
      const runtime = yield* f.open(context);
      const running = yield* runtime
        .run(f.firstInput, context)
        .pipe(Effect.result, Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* f.instance.adapter.terminal();
      expect(Result.isFailure(yield* Fiber.join(running))).toBe(true);
      expect(f.exports).toHaveLength(0);
      expect(f.terminals).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects native background work after the terminal", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      f.instance.adapter.setPendingBackground(true);
      const context = f.context("request-1");
      const runtime = yield* f.open(context);
      const running = yield* runtime
        .run(f.firstInput, context)
        .pipe(Effect.result, Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* f.instance.adapter.terminal();
      expect(Result.isFailure(yield* Fiber.join(running))).toBe(true);
      expect(f.exports).toHaveLength(0);
      expect(f.terminals).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves the complete failed terminal in the result writer", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const context = f.context("request-1");
      const runtime = yield* f.open(context);
      const running = yield* runtime.run(f.firstInput, context).pipe(Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* f.instance.adapter.named();
      const failure = {
        class: "provider_error" as const,
        message: "Model rejected the turn",
        code: "MODEL_REFUSED",
        retryable: false,
      };
      yield* f.instance.adapter.emit({
        type: "turn.terminal",
        driver: f.instance.adapter.runtime.driver,
        providerThreadId: f.instance.adapter.turn.providerThread.id,
        providerTurnId: f.instance.adapter.native().id,
        runOrdinal: 1,
        failureItemOrdinal: 7,
        status: "failed",
        failure,
        threadDisposition: "broken",
      });
      expect((yield* Fiber.join(running)).status).toBe("failed");
      expect(f.terminals[0]?.event).toMatchObject({
        status: "failed",
        failure,
        failureItemOrdinal: 7,
        threadDisposition: "broken",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects writer artifacts that do not verify and never writes a result", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const context = f.context("request-1");
      const runtime = yield* createHarnessRequestTurn({
        ...f.options,
        writeCheckpoint: () =>
          Effect.succeed({ native: f.reference("seed-native"), filesystem: f.initial.filesystem }),
      })(f.initial, context);
      const running = yield* runtime
        .run(f.firstInput, context)
        .pipe(Effect.result, Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* f.instance.adapter.terminal();
      expect(Result.isFailure(yield* Fiber.join(running))).toBe(true);
      expect(f.terminals).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("fails an unfinished request when the canonical event stream fails", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      f.instance.adapter.setStartGate(Effect.never);
      const context = f.context("request-1");
      const runtime = yield* f.open(context);
      const running = yield* runtime
        .run(f.firstInput, context)
        .pipe(Effect.result, Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* f.instance.adapter.endEvents;
      expect(Result.isFailure(yield* Fiber.join(running))).toBe(true);
      expect(f.exports).toHaveLength(0);
      expect(f.terminals).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
});
