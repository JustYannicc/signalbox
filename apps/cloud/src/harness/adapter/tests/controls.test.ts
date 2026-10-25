import { describe, expect, it } from "@effect/vitest";
import {
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { fixture } from "./fixture.ts";

const running = Effect.gen(function* () {
  const f = yield* fixture;
  const opened = yield* f.open();
  yield* opened.session.turn(f.turn);
  yield* opened.next;
  yield* opened.next;
  return { ...f, ...opened };
});

describe("AdapterHarness controls", () => {
  it.effect("retains an interrupt until the native turn is named and applies it once", () =>
    Effect.gen(function* () {
      const f = yield* running;
      const interrupt = {
        type: "interrupt" as const,
        runId: f.turn.runId,
        preparationGeneration: 1,
      };
      yield* f.session.control(interrupt);
      yield* f.session.control(interrupt);
      yield* f.emit({
        type: "provider_turn.updated",
        driver: f.runtime.driver,
        providerTurn: { ...f.native(), status: "pending", nativeTurnRef: null },
      });
      yield* f.next;
      expect(f.controls).toHaveLength(0);
      yield* f.named();
      const applied = yield* f.nextInterrupt;
      yield* f.next;
      expect(applied.providerTurnId).toBe(f.native().id);
      yield* f.named();
      yield* f.next;
      yield* f.session.control(interrupt);
      expect(f.controls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fences runtime responses to the active attempt, session, observed request and current native turn",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        yield* f.named();
        yield* f.next;
        const requestId = RuntimeRequestId.make("request");
        const response = {
          type: "runtime-request.respond" as const,
          runId: f.turn.runId,
          attemptId: f.turn.attemptId,
          providerSessionId: f.runtime.providerSessionId,
          requestId,
          decision: "accept" as const,
          answers: undefined,
        };
        expect(Result.isFailure(yield* f.session.control(response).pipe(Effect.result))).toBe(true);
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
        const stale = [
          { ...response, runId: RunId.make("old") },
          { ...response, attemptId: RunAttemptId.make("old") },
          { ...response, providerSessionId: ProviderSessionId.make("old") },
          { ...response, requestId: RuntimeRequestId.make("unknown") },
        ];
        for (const control of stale)
          expect(Result.isFailure(yield* f.session.control(control).pipe(Effect.result))).toBe(
            true,
          );
        expect(f.controls).toHaveLength(0);
        yield* f.named(f.turn, 2);
        yield* f.next;
        expect(Result.isFailure(yield* f.session.control(response).pipe(Effect.result))).toBe(true);
        const currentRequest = {
          type: "runtime_request.updated" as const,
          driver: f.runtime.driver,
          threadId: f.turn.threadId,
          runtimeRequest: {
            id: RuntimeRequestId.make("current-request"),
            nodeId: f.turn.rootNodeId,
            providerTurnId: f.native(f.turn, 2).id,
            nativeRequestRef: null,
            kind: "command" as const,
            status: "pending" as const,
            responseCapability: {
              type: "live" as const,
              providerSessionId: f.runtime.providerSessionId,
            },
            createdAt: f.native().startedAt!,
            resolvedAt: null,
          },
        };
        yield* f.emit(currentRequest);
        yield* f.next;
        const currentResponse = { ...response, requestId: currentRequest.runtimeRequest.id };
        yield* f.session.control(currentResponse);
        expect(f.controls).toEqual([{ requestId: currentResponse.requestId, decision: "accept" }]);
        yield* f.next;
        expect(
          Result.isFailure(yield* f.session.control(currentResponse).pipe(Effect.result)),
        ).toBe(true);
        yield* f.emit(currentRequest);
        yield* f.named(f.turn, 2);
        yield* f.next;
        expect(
          Result.isFailure(yield* f.session.control(currentResponse).pipe(Effect.result)),
        ).toBe(true);
        yield* f.session.control({ type: "steer", runId: f.turn.runId, message: f.turn.message });
        yield* f.session.control({ type: "steer", runId: f.turn.runId, message: f.turn.message });
        expect(f.controls).toHaveLength(2);
        expect(f.controls[1]).toMatchObject({ providerTurnId: f.native(f.turn, 2).id });
      }).pipe(Effect.scoped),
  );

  it.effect("rejects stale run controls and drops late provider terminal events", () =>
    Effect.gen(function* () {
      const f = yield* running;
      yield* f.named();
      yield* f.next;
      expect(
        Result.isFailure(
          yield* f.session
            .control({ type: "interrupt", runId: f.turn.runId, preparationGeneration: 2 })
            .pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* f.session
            .control({ type: "steer", runId: RunId.make("old"), message: f.turn.message })
            .pipe(Effect.result),
        ),
      ).toBe(true);
      yield* f.emit({
        type: "turn.terminal",
        driver: f.runtime.driver,
        providerThreadId: f.turn.providerThread.id,
        providerTurnId: ProviderTurnId.make("old"),
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* f.named();
      const event = yield* f.next;
      expect(event.kind === "provider" && event.event.type).toBe("provider_turn.updated");
      expect(f.calls).not.toContain("save");
      yield* f.session.control({
        type: "interrupt",
        runId: f.turn.runId,
        preparationGeneration: 1,
      });
      expect(f.controls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
