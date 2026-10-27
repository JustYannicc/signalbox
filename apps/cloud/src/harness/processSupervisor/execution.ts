import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  HarnessProcessSupervisorStaleOwnerError,
  SupervisorCheckpoint,
  SupervisorSignal,
  type HarnessProcessSupervisorBlocker,
  type HarnessProcessSupervisorOptions,
  type HarnessProcessSupervisorOutcome,
} from "./contracts.ts";
import { resumeThroughCaller } from "./caller.ts";
import { blocker, parse, sameIncarnation, type SupervisorJournal } from "./state.ts";

type Notice = { readonly _tag: "Reset" } | HarnessProcessSupervisorBlocker;
const isStaleOwnerError = Schema.is(HarnessProcessSupervisorStaleOwnerError);

const observe = (journal: SupervisorJournal, supplied: typeof SupervisorSignal.Type) =>
  Effect.gen(function* () {
    const signal = yield* parse(SupervisorSignal, structuredClone(supplied));
    let notice: Notice | null = null;
    yield* journal.change(
      (state) => {
        const existing = state.signals.find((receipt) => receipt.signal.eventId === signal.eventId);
        if (existing !== undefined) {
          const left = existing.signal;
          if (
            left.kind === signal.kind &&
            left.turnId === signal.turnId &&
            left.nativeSessionId === signal.nativeSessionId &&
            sameIncarnation(left.incarnation, signal.incarnation)
          )
            return state;
          notice = blocker(state, "conflicting-id");
          return { ...state, phase: "blocked", blocker: notice };
        }
        const sameTurn =
          signal.nativeSessionId === state.checkpoint.nativeSessionId &&
          signal.turnId === state.turn?.turnId;
        const pending =
          sameTurn &&
          state.phase === "resuming" &&
          signal.incarnation.generation === state.incarnation.generation + 1;
        const isStale = !sameTurn || !sameIncarnation(signal.incarnation, state.incarnation);
        const disposition = pending
          ? "pending"
          : isStale
            ? "stale"
            : state.phase === "running"
              ? "accepted"
              : "inactive";
        const next = { ...state, signals: [...state.signals, { signal, disposition } as const] };
        if (disposition !== "accepted") return next;
        notice = { _tag: "Reset" };
        return {
          ...next,
          phase: "reset-observed",
          failedRestarts: state.failedRestarts + Number(state.attempt > 0),
        };
      },
      (state) =>
        state.phase === "blocked"
          ? "blocked"
          : state.signals.at(-1)?.disposition === "accepted"
            ? "signal-accepted"
            : state.signals.at(-1)?.disposition === "stale"
              ? "signal-stale"
              : state.signals.at(-1)?.disposition === "pending"
                ? "signal-pending"
                : "signal-inactive",
    );
    return notice;
  });

const restart = (options: HarnessProcessSupervisorOptions, journal: SupervisorJournal) =>
  Effect.gen(function* () {
    const current = journal.current();
    if (current.phase === "blocked") return current.blocker!;
    if (current.failedRestarts >= current.policy.maxFailedRestarts)
      return yield* journal.park("restart-limit", "retry");
    const intent = yield* journal.change(
      (state) =>
        state.phase === "blocked"
          ? state
          : {
              ...state,
              phase: "resuming",
              attempt: state.attempt + 1,
              operationId: `${state.ownerId}:${state.revision + 1}`,
            },
      "restart-intent",
    );
    if (intent.phase === "blocked") return intent.blocker!;
    if (intent.turn === null || intent.operationId === null)
      return yield* journal.park("identity-mismatch");
    yield* journal.assertOpen;
    const result = yield* resumeThroughCaller(options.caller, {
      operationId: intent.operationId,
      attempt: intent.attempt,
      turn: intent.turn,
      incarnation: intent.incarnation,
      checkpoint: intent.checkpoint,
    }).pipe(
      Effect.map((incarnation) => ({ _tag: "Resumed" as const, incarnation })),
      Effect.catch((error) =>
        journal.park(
          error._tag === "HarnessProcessResumeError" &&
            error.reason === "identity-or-checkpoint-mismatch"
            ? "identity-mismatch"
            : "resume-failed",
          "reconcile",
          error._tag === "HarnessProcessResumeError"
            ? { stage: error.stage, reason: error.reason, recovery: error.recovery }
            : null,
          true,
        ),
      ),
    );
    if (result._tag === "Blocker") return result;
    const published = yield* journal.change((state) => {
      if (state.phase === "blocked") return state;
      // A fresh incarnation may reset before C's reply arrives. Only C's confirmed
      // identity can turn that buffered platform observation into a restart trigger.
      let reset = false;
      const signals = state.signals.map((receipt) => {
        if (receipt.disposition !== "pending") return receipt;
        const matches = sameIncarnation(receipt.signal.incarnation, result.incarnation);
        const disposition = !matches ? "stale" : reset ? "inactive" : "accepted";
        reset ||= matches;
        return { ...receipt, disposition } as const;
      });
      return {
        ...state,
        incarnation: result.incarnation,
        signals,
        phase: reset ? "reset-observed" : "running",
        failedRestarts: state.failedRestarts + Number(reset),
      };
    }, "resumed");
    if (published.phase === "blocked") return published.blocker!;
    if (published.phase === "reset-observed") return { _tag: "Reset" as const };
    return result;
  });

/** No effect is replayed after an uncertain reply. C's retained resources remain C's responsibility. */
export const settleFailure = (journal: SupervisorJournal, cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const reason = Cause.hasInterrupts(cause)
    ? "cancelled"
    : isStaleOwnerError(error)
      ? "stale-owner"
      : "effect-uncertain";
  const recovery = reason === "stale-owner" ? "new-owner" : "reconcile";
  return journal
    .park(reason, recovery)
    .pipe(Effect.catchCause(() => Effect.succeed(blocker(journal.current(), reason, recovery))));
};

export const executeTurn = (
  options: HarnessProcessSupervisorOptions,
  journal: SupervisorJournal,
  resumeFirst: boolean,
): Effect.Effect<HarnessProcessSupervisorOutcome> =>
  Effect.scoped(
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<Notice>();
      const subscription = yield* options.ingress.subscribe;
      const listen = Effect.gen(function* () {
        while (true) {
          const signal = yield* subscription.take;
          const notice = yield* observe(journal, signal);
          if (notice !== null) yield* Queue.offer(notices, notice);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
            const error = Option.getOrUndefined(Cause.findErrorOption(cause));
            const notice = isStaleOwnerError(error)
              ? blocker(journal.current(), "stale-owner", "new-owner")
              : yield* journal
                  .park("ingress-failed")
                  .pipe(Effect.catchCause((failure) => settleFailure(journal, failure)));
            yield* Queue.offer(notices, notice);
          }),
        ),
      );
      yield* Effect.forkScoped(listen);
      let needsResume = resumeFirst;
      while (true) {
        if (needsResume) {
          const resumed = yield* Effect.raceFirst(restart(options, journal), Queue.take(notices));
          if (resumed._tag === "Blocker") return resumed;
          if (resumed._tag === "Reset") continue;
          needsResume = false;
        }
        yield* journal.assertOpen;
        const active = journal.current();
        if (active.phase === "blocked") return active.blocker!;
        if (active.phase === "reset-observed") {
          const notice = yield* Queue.take(notices);
          if (notice._tag === "Blocker") return notice;
          needsResume = true;
          continue;
        }
        if (active.turn === null) return yield* journal.park("identity-mismatch");
        const turn = active.turn;
        const result = yield* Effect.raceFirst(
          Effect.gen(function* () {
            const current = journal.current();
            if (current.phase === "blocked") return current.blocker!;
            if (current.phase === "reset-observed") return yield* Queue.take(notices);
            return yield* options.caller
              .turn({
                turn,
                incarnation: active.incarnation,
                checkpoint: active.checkpoint,
                mode: active.attempt === 0 ? "start" : "resume",
              })
              .pipe(
                Effect.map((completion) => ({ _tag: "TurnCompleted" as const, completion })),
                Effect.catch(() =>
                  journal.park("runtime-failed", "reconcile", null, active.attempt > 0),
                ),
              );
          }),
          Queue.take(notices),
        );
        if (result._tag === "Blocker") return result;
        if (result._tag === "Reset") {
          needsResume = true;
          continue;
        }
        const { completion } = result;
        const checkpoint = yield* parse(
          SupervisorCheckpoint,
          structuredClone(completion.checkpoint),
        );
        if (
          completion.turnId !== active.turn.turnId ||
          !sameIncarnation(completion.incarnation, active.incarnation) ||
          checkpoint.nativeSessionId !== active.checkpoint.nativeSessionId ||
          checkpoint.completedTurnId !== active.turn.turnId ||
          checkpoint.checkpointId === active.checkpoint.checkpointId
        )
          return yield* journal.park("identity-mismatch");
        const outcome = { _tag: "Completed" as const, turnId: active.turn.turnId, checkpoint };
        const committed = yield* journal.change(
          (state) =>
            state.phase !== "running" ||
            !sameIncarnation(state.incarnation, active.incarnation) ||
            state.turn?.requestId !== turn.requestId
              ? state
              : {
                  ...state,
                  checkpoint,
                  phase: "completed",
                  failedRestarts: 0,
                  blocker: null,
                  turns: state.turns.map((receipt) =>
                    receipt.request.requestId === turn.requestId
                      ? { ...receipt, result: outcome }
                      : receipt,
                  ),
                },
          "completed",
        );
        if (committed.phase === "blocked") return committed.blocker!;
        // A committed completion racing an accepted reset needs C reconciliation.
        // Replaying that turn could repeat work that the caller already committed.
        if (committed.phase !== "completed") return yield* journal.park("effect-uncertain");
        return outcome;
      }
    }),
  ).pipe(Effect.catchCause((cause) => settleFailure(journal, cause)));
