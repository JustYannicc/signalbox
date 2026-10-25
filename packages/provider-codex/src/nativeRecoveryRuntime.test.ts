import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  ProviderAdapterProtocolError,
  ProviderAdapterTurnStartError,
  ProviderAdapterInterruptError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { fixture, run } from "./tests/nativeRecoveryTestkit.ts";

const isTurnStartError = Schema.is(ProviderAdapterTurnStartError);
const isProtocolError = Schema.is(ProviderAdapterProtocolError);
const isInterruptError = Schema.is(ProviderAdapterInterruptError);

describe("Codex explicit native recovery protocol", () => {
  it.effect(
    "reopens without a turn, then starts a new native turn on the same logical run with no prompt refeed",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.runtime.resumeThread({ providerThread: f.turn.providerThread });
          expect(f.requests.map((r) => r.method)).toEqual(["thread/resume"]);
          expect(f.receipts).toEqual([]);
          yield* f.runtime.startTurn(f.turn);
          expect(f.order).toEqual(["thread/resume", "reserve", "turn/start"]);
          expect(f.requests[1]?.params).toMatchObject({ threadId: "native-session", input: [] });
          expect(JSON.stringify(f.requests[1])).not.toContain(f.turn.message.text);
          expect(f.receipts.find((r) => r.status === "continued")).toMatchObject({
            nativeTurnId: "replacement-native-turn",
            admission: { logicalRunId: f.turn.runId, nativeIncarnationId: "boot-2" },
          });
          expect(f.receipts.some((r) => r.status === "native-admitted")).toBe(false);
        }),
      ),
  );
  it.effect("observes a native start separately from an accepted, still queued turn", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ delayedStart: true });
        yield* f.runtime.startTurn(f.turn);
        expect(f.receipts.some((r) => r.status === "native-accepted")).toBe(true);
        expect(f.receipts.some((r) => r.status === "continued")).toBe(false);
        yield* f.started;
        yield* Deferred.await(f.continued);
        expect(f.receipts.filter((r) => r.status === "continued")).toHaveLength(1);
      }),
    ),
  );
  it.effect(
    "reserves a fresh input ID before native admission and never admits the reservation as durable",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({ fresh: true });
          yield* f.runtime.startTurn(f.turn);
          expect(f.order).toEqual(["reserve", "turn/start"]);
          expect(f.requests[0]?.params).toMatchObject({
            clientUserMessageId: f.turn.message.messageId,
          });
          expect(f.receipts.filter((r) => r.status === "native-admitted")).toEqual([]);
          expect((yield* Effect.exit(f.runtime.startTurn(f.turn)))._tag).toBe("Failure");
          expect(f.requests).toHaveLength(1);
        }),
      ),
  );
  it.effect(
    "keeps uncertain acceptance indeterminate and refuses an unchanged second dispatch",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({ loseReply: true });
          expect((yield* Effect.exit(f.runtime.startTurn(f.turn)))._tag).toBe("Failure");
          expect(f.receipts.at(-1)?.status).toBe("indeterminate");
          expect((yield* Effect.exit(f.runtime.startTurn(f.turn)))._tag).toBe("Failure");
          expect(f.requests).toHaveLength(1);
        }),
      ),
  );
  it.effect("does not touch the native turn when reservation persistence fails", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ denyReservation: true });
        const failure = yield* Effect.flip(f.runtime.startTurn(f.turn));
        expect(isTurnStartError(failure)).toBe(true);
        if (!isTurnStartError(failure)) return;
        const protocolError = failure.cause;
        expect(isProtocolError(protocolError)).toBe(true);
        if (!isProtocolError(protocolError)) return;
        expect(protocolError.cause).toBe(f.reservationFailure);
        expect(f.requests).toEqual([]);
      }),
    ),
  );
  it.effect("reports a receipt persistence failure without continuing or dispatching again", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ rejectReceipt: "native-accepted" });
        const failure = yield* Effect.flip(f.runtime.startTurn(f.turn));
        expect(isTurnStartError(failure)).toBe(true);
        if (!isTurnStartError(failure)) return;
        const protocolError = failure.cause;
        expect(isProtocolError(protocolError)).toBe(true);
        if (!isProtocolError(protocolError)) return;
        expect(protocolError.detail).toBe("Native recovery receipt could not be persisted.");
        expect(protocolError.cause).toBe(f.receiptFailure);
        expect(f.receiptAttempts.map((receipt) => receipt.status)).toEqual([
          "reserved",
          "native-accepted",
        ]);
        expect(f.receipts.map((receipt) => receipt.status)).toEqual(["reserved"]);
        expect(f.requests.map((request) => request.method)).toEqual(["turn/start"]);
        expect((yield* Effect.exit(f.runtime.startTurn(f.turn)))._tag).toBe("Failure");
        expect(f.requests).toHaveLength(1);
      }),
    ),
  );
  it.effect("keeps a lost completion receipt fatal with the original protocol error", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ rejectReceipt: "completed" });
        yield* f.runtime.startTurn(f.turn);
        yield* f.completed;
        const exit = yield* Deferred.await(f.completionHandled);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const defect = Cause.findDefect(exit.cause);
        expect(Result.isSuccess(defect)).toBe(true);
        if (!Result.isSuccess(defect)) return;
        const protocolError = defect.success;
        expect(isProtocolError(protocolError)).toBe(true);
        if (!isProtocolError(protocolError)) return;
        expect(protocolError.cause).toBe(f.receiptFailure);
        expect(f.receiptAttempts.at(-1)?.status).toBe("completed");
        expect(f.receipts.some((receipt) => receipt.status === "completed")).toBe(false);
      }),
    ),
  );
  it.effect("blocks completion after early native start and a failed acceptance receipt", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ earlyStart: true, rejectReceipt: "native-accepted" });
        const failure = yield* Effect.flip(f.runtime.startTurn(f.turn));
        expect(isTurnStartError(failure)).toBe(true);
        if (!isTurnStartError(failure)) return;
        const protocolError = failure.cause;
        expect(isProtocolError(protocolError)).toBe(true);
        if (!isProtocolError(protocolError)) return;
        expect(protocolError.cause).toBe(f.receiptFailure);
        expect(f.receiptAttempts.map((receipt) => receipt.status)).toEqual([
          "reserved",
          "continued",
          "native-accepted",
        ]);
        yield* f.completed;
        const completion = yield* Deferred.await(f.completionHandled);
        const events = yield* f.readEvents;
        expect(
          events
            .filter((event) => event.type === "provider_turn.updated")
            .map((event) => event.providerTurn.status),
        ).toEqual(["running"]);
        expect(events.some((event) => event.type === "turn.terminal")).toBe(false);
        expect(f.receiptAttempts.at(-1)?.status).toBe("native-accepted");
        expect(f.receipts.some((receipt) => receipt.status === "completed")).toBe(false);
        expect(Exit.isFailure(completion)).toBe(true);
        if (!Exit.isFailure(completion)) return;
        expect(Cause.findDefect(completion.cause)).toEqual(Result.succeed(protocolError));
        const repeated = yield* Effect.flip(f.runtime.startTurn(f.turn));
        expect(isTurnStartError(repeated)).toBe(true);
        if (!isTurnStartError(repeated)) return;
        expect(repeated.cause).toBe(protocolError);
        expect(f.requests).toHaveLength(1);
      }),
    ),
  );
  it.effect("finishes an early native turn when every receipt is persisted", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ earlyStart: true });
        yield* f.runtime.startTurn(f.turn);
        yield* f.completed;
        expect(Exit.isSuccess(yield* Deferred.await(f.completionHandled))).toBe(true);
        const events = yield* f.readEvents;
        expect(
          events
            .filter((event) => event.type === "provider_turn.updated")
            .map((event) => event.providerTurn.status),
        ).toEqual(["running", "completed"]);
        expect(events.filter((event) => event.type === "turn.terminal")).toMatchObject([
          { status: "completed" },
        ]);
        expect(f.receipts.at(-1)?.status).toBe("completed");
      }),
    ),
  );
  it.effect("preserves the native request error when its indeterminate receipt also fails", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ loseReply: true, rejectReceipt: "indeterminate" });
        const failure = yield* Effect.flip(f.runtime.startTurn(f.turn));
        expect(isTurnStartError(failure)).toBe(true);
        if (!isTurnStartError(failure)) return;
        const protocolError = failure.cause;
        expect(isProtocolError(protocolError)).toBe(true);
        if (!isProtocolError(protocolError)) return;
        expect(protocolError.cause).toBe(f.receiptFailure);
        expect(f.requestFailures).toHaveLength(1);
        expect(protocolError.payload).toBe(f.requestFailures[0]);
        expect(protocolError.payload).toMatchObject({ _tag: "CodexAppServerRequestError" });
      }),
    ),
  );
  it.effect.each(["releaseGoal", "continueGoal"] as const)(
    "blocks %s after a completed goal hold and late acceptance failure",
    (operation) =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({ earlyGoalCompletion: true, rejectReceipt: "native-accepted" });
          const failure = yield* Effect.flip(f.runtime.startTurn(f.turn));
          expect(isTurnStartError(failure)).toBe(true);
          if (!isTurnStartError(failure)) return;
          const protocolError = failure.cause;
          expect(isProtocolError(protocolError)).toBe(true);
          expect(f.receipts.map((r) => r.status)).toEqual(["reserved", "continued", "completed"]);
          const result = yield* f[operation];
          const events = yield* f.readEvents;
          expect(
            events
              .filter((e) => e.type === "provider_turn.updated")
              .map((e) => e.providerTurn.status),
          ).toEqual(["running"]);
          expect(events.some((e) => e.type === "turn.terminal")).toBe(false);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.findDefect(result.cause)).toEqual(Result.succeed(protocolError));
        }),
      ),
  );
  it.effect.each(["releaseGoal", "continueGoal"] as const)(
    "allows %s when every receipt was persisted",
    (operation) =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({ earlyGoalCompletion: true });
          yield* f.runtime.startTurn(f.turn);
          expect(Exit.isSuccess(yield* f[operation])).toBe(true);
          const events = yield* f.readEvents;
          expect(
            events
              .filter((e) => e.type === "provider_turn.updated")
              .map((e) => e.providerTurn.status),
          ).toEqual(
            operation === "releaseGoal"
              ? ["running", "running", "completed"]
              : ["running", "running", "completed", "running"],
          );
          expect(events.filter((e) => e.type === "turn.terminal")).toMatchObject(
            operation === "releaseGoal" ? [{ status: "completed" }] : [],
          );
        }),
      ),
  );
  it.effect(
    "returns a typed interrupt error with the sticky protocol failure and no settlement",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({ earlyGoalCompletion: true, rejectReceipt: "native-accepted" });
          const failure = yield* Effect.flip(f.runtime.startTurn(f.turn));
          if (!isTurnStartError(failure)) return yield* Effect.die("expected start failure");
          const before = yield* f.readEvents;
          const started = before.find((e) => e.type === "provider_turn.updated");
          if (started?.type !== "provider_turn.updated")
            return yield* Effect.die("missing running turn");
          const result = yield* Effect.exit(
            f.runtime.interruptTurn({
              providerThread: f.turn.providerThread,
              providerTurnId: started.providerTurn.id,
            }),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (!Exit.isFailure(result)) return;
          const error = Cause.findError(result.cause);
          expect(Result.isSuccess(error)).toBe(true);
          if (!Result.isSuccess(error)) return;
          expect(isInterruptError(error.success)).toBe(true);
          if (!isInterruptError(error.success)) return;
          expect(error.success.cause).toBe(failure.cause);
          expect(yield* f.readEvents).toEqual([]);
          expect(f.requests.map((r) => r.method)).toEqual(["turn/start"]);
        }),
      ),
  );
});
