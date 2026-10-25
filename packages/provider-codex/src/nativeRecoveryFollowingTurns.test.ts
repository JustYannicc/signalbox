import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  ProviderAdapterProtocolError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { MessageId, RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { fixture, run } from "./tests/nativeRecoveryTestkit.ts";

const isTurnStartError = Schema.is(ProviderAdapterTurnStartError);
const isProtocolError = Schema.is(ProviderAdapterProtocolError);

function nativeRecoveryDetail(exit: Exit.Exit<void, unknown>) {
  if (Exit.isSuccess(exit)) return undefined;
  const error = Cause.findError(exit.cause);
  if (
    !Result.isSuccess(error) ||
    !isTurnStartError(error.success) ||
    !isProtocolError(error.success.cause)
  )
    return undefined;
  return error.success.cause.detail;
}

function distinctTurn(
  turn: ProviderAdapterV2TurnInput,
  runId: string,
  messageId: string,
  text: string,
): ProviderAdapterV2TurnInput {
  return {
    ...turn,
    runId: RunId.make(runId),
    message: { ...turn.message, messageId: MessageId.make(messageId), text },
  };
}

describe("Codex turns after native recovery", () => {
  it.effect("allows a distinct ordinary turn after a recovered continuation completes", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.runtime.resumeThread({ providerThread: f.turn.providerThread });
        yield* f.runtime.startTurn(f.turn);
        expect(f.requests[1]?.params).toMatchObject({ threadId: "native-session", input: [] });
        expect(JSON.stringify(f.requests[1])).not.toContain(f.turn.message.text);

        yield* f.started;
        yield* Deferred.await(f.continued);
        yield* f.completed;
        const completion = yield* Deferred.await(f.completionHandled);
        expect(Exit.isSuccess(completion)).toBe(true);
        expect(f.receipts.at(-1)?.status).toBe("completed");

        const nextTurn = {
          ...f.turn,
          runId: RunId.make("post-recovery-run"),
          message: {
            ...f.turn.message,
            messageId: MessageId.make("post-recovery-message"),
            text: "POST-RECOVERY DISTINCT INPUT",
          },
        };
        const nextExit = yield* Effect.exit(f.runtime.startTurn(nextTurn));
        let failureDetail = "none";
        if (Exit.isFailure(nextExit)) {
          const error = Cause.findError(nextExit.cause);
          if (
            Result.isSuccess(error) &&
            isTurnStartError(error.success) &&
            isProtocolError(error.success.cause)
          )
            failureDetail = error.success.cause.detail;
        }
        expect(
          Exit.isSuccess(nextExit),
          `distinct ordinary turn was rejected: ${failureDetail}`,
        ).toBe(true);
        expect(f.requests.map((request) => request.method)).toEqual([
          "thread/resume",
          "turn/start",
          "turn/start",
        ]);
        expect(JSON.stringify(f.requests[2]?.params)).toContain(nextTurn.message.text);
        expect(f.receipts.map((receipt) => receipt.status)).toEqual([
          "reserved",
          "native-accepted",
          "continued",
          "completed",
        ]);

        const replay = yield* Effect.exit(f.runtime.startTurn(f.turn));
        expect(Exit.isFailure(replay)).toBe(true);
        expect(f.requests).toHaveLength(3);
      }),
    ),
  );
  it.effect("joins a next turn triggered by the emitted recovery terminal", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const nextTurn = distinctTurn(
          f.turn,
          "terminal-triggered-run",
          "terminal-triggered-message",
          "TERMINAL-TRIGGERED INPUT",
        );
        const nextTurnExit = yield* Deferred.make<Exit.Exit<void, unknown>>();
        let triggered = false;
        const terminalConsumer = yield* f.runtime.events.pipe(
          Stream.runForEach((event) => {
            if (event.type !== "turn.terminal" || triggered) return Effect.void;
            triggered = true;
            return f.runtime.startTurn(nextTurn).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.succeed(nextTurnExit, exit)),
              Effect.asVoid,
            );
          }),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* f.runtime.startTurn(f.turn);
        yield* f.started;
        yield* Deferred.await(f.continued);
        yield* f.completed;
        expect(Exit.isSuccess(yield* Deferred.await(f.completionHandled))).toBe(true);

        expect(Exit.isSuccess(yield* Deferred.await(nextTurnExit))).toBe(true);
        expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
        const nextNativeTurnId = f.nativeTurnIds.at(-1);
        if (nextNativeTurnId === undefined) return yield* Effect.die("missing next native turn id");
        yield* f.observeStarted(nextNativeTurnId);
        yield* f.observeCompleted(nextNativeTurnId);
        yield* Fiber.interrupt(terminalConsumer);
      }),
    ),
  );
  it.effect("keeps run and input identity mismatches fenced", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const wrongRun = { ...f.turn, runId: RunId.make("different-run") };
        const wrongInput = {
          ...f.turn,
          message: {
            ...f.turn.message,
            messageId: MessageId.make("different-message"),
          },
        };
        expect(nativeRecoveryDetail(yield* Effect.exit(f.runtime.startTurn(wrongRun)))).toBe(
          "Native recovery admission is stale, mismatched, or already consumed.",
        );
        expect(nativeRecoveryDetail(yield* Effect.exit(f.runtime.startTurn(wrongInput)))).toBe(
          "Native recovery admission is stale, mismatched, or already consumed.",
        );
        expect(f.requests).toEqual([]);
        expect(f.receiptAttempts).toEqual([]);
      }),
    ),
  );
  it.effect("blocks a distinct input before the recovery admission is claimed", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const nextTurn = distinctTurn(
          f.turn,
          "pre-claim-run",
          "pre-claim-message",
          "PRE-CLAIM INPUT",
        );
        const exit = yield* Effect.exit(f.runtime.startTurn(nextTurn));
        expect(nativeRecoveryDetail(exit)).toBe(
          "Native recovery admission is stale, mismatched, or already consumed.",
        );
        expect(f.requests).toEqual([]);
        expect(f.receiptAttempts).toEqual([]);
      }),
    ),
  );
  it.effect("blocks a distinct input while the recovered turn is still active", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.runtime.startTurn(f.turn);
        const nextTurn = distinctTurn(
          f.turn,
          "active-recovery-run",
          "active-recovery-message",
          "ACTIVE RECOVERY INPUT",
        );
        const exit = yield* Effect.exit(f.runtime.startTurn(nextTurn));
        expect(nativeRecoveryDetail(exit)).toBe(
          "Native recovery admission is stale, mismatched, or already consumed.",
        );
        expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
        expect(f.receipts.map((receipt) => receipt.status)).toEqual([
          "reserved",
          "native-accepted",
          "continued",
        ]);
      }),
    ),
  );
  it.effect("fences following turns to the recovered native session", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.runtime.startTurn(f.turn);
        yield* f.started;
        yield* Deferred.await(f.continued);
        yield* f.completed;
        expect(Exit.isSuccess(yield* Deferred.await(f.completionHandled))).toBe(true);

        const nextTurn = distinctTurn(
          f.turn,
          "wrong-native-session-run",
          "wrong-native-session-message",
          "WRONG SESSION INPUT",
        );
        const wrongSessionTurn = {
          ...nextTurn,
          providerThread: {
            ...nextTurn.providerThread,
            nativeThreadRef: {
              ...nextTurn.providerThread.nativeThreadRef!,
              nativeId: "another-native-session",
            },
          },
        };
        const exit = yield* Effect.exit(f.runtime.startTurn(wrongSessionTurn));
        expect(nativeRecoveryDetail(exit)).toBe(
          "Native recovery admission is stale, mismatched, or already consumed.",
        );
        expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
      }),
    ),
  );
  it.effect("keeps a failed completion receipt sticky for a distinct goal command", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ rejectReceipt: "completed" });
        yield* f.runtime.startTurn(f.turn);
        yield* f.started;
        yield* Deferred.await(f.continued);
        yield* f.completed;
        expect(Exit.isFailure(yield* Deferred.await(f.completionHandled))).toBe(true);

        const goalTurn = distinctTurn(
          f.turn,
          "failed-completion-goal-run",
          "failed-completion-goal-message",
          "/goal pause",
        );
        const exit = yield* Effect.exit(f.runtime.startTurn(goalTurn));
        expect(nativeRecoveryDetail(exit)).toBe("Native recovery receipt could not be persisted.");
        expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
        expect(f.requests.some((request) => request.method === "thread/goal/set")).toBe(false);
        expect(f.receipts.map((receipt) => receipt.status)).toEqual([
          "reserved",
          "native-accepted",
          "continued",
        ]);
      }),
    ),
  );
  it.effect("lets goal commands run only after the recovery turn is finalized", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const goalTurn = distinctTurn(
          f.turn,
          "goal-after-recovery-run",
          "goal-after-recovery-message",
          "/goal pause",
        );
        const early = yield* Effect.exit(f.runtime.startTurn(goalTurn));
        expect(nativeRecoveryDetail(early)).toBe(
          "Native recovery admission is stale, mismatched, or already consumed.",
        );
        expect(f.requests).toEqual([]);

        yield* f.runtime.startTurn(f.turn);
        yield* f.started;
        yield* Deferred.await(f.continued);
        yield* f.completed;
        expect(Exit.isSuccess(yield* Deferred.await(f.completionHandled))).toBe(true);

        expect(Exit.isSuccess(yield* Effect.exit(f.runtime.startTurn(goalTurn)))).toBe(true);
        expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
        expect(f.receipts.map((receipt) => receipt.status)).toEqual([
          "reserved",
          "native-accepted",
          "continued",
          "completed",
        ]);
      }),
    ),
  );
  it.effect("keeps a recovery receipt persistence failure sticky across a distinct run", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ rejectReceipt: "native-accepted" });
        const first = yield* Effect.exit(f.runtime.startTurn(f.turn));
        expect(nativeRecoveryDetail(first)).toBe("Native recovery receipt could not be persisted.");

        const nextTurn = {
          ...f.turn,
          runId: RunId.make("post-failure-run"),
          message: {
            ...f.turn.message,
            messageId: MessageId.make("post-failure-message"),
            text: "/goal pause",
          },
        };
        const next = yield* Effect.exit(f.runtime.startTurn(nextTurn));
        expect(nativeRecoveryDetail(next)).toBe("Native recovery receipt could not be persisted.");
        expect(f.requests.map((request) => request.method)).toEqual(["turn/start"]);
        expect(f.receiptAttempts.map((receipt) => receipt.status)).toEqual([
          "reserved",
          "native-accepted",
        ]);
      }),
    ),
  );
});
