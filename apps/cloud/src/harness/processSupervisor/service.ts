import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  SupervisorRetry,
  SupervisorTurn,
  type HarnessProcessSupervisorOptions,
  type HarnessProcessSupervisorOutcome,
  type HarnessProcessSupervisorRetry,
  type HarnessProcessSupervisorTurn,
} from "./contracts.ts";
import { blocker, createJournal, parse } from "./state.ts";
import { executeTurn } from "./execution.ts";
import { admitRun, admitRetry } from "./requests.ts";

/** Owns control fibers and the ingress subscription, not C's retained native resources.
 * Opening a replacement fences old writes to this record, not C's physical process.
 * In-flight work parks for reconciliation through C's existing ownership machinery.
 * Interrupting run/retry closes this instance, including any duplicate waiters. */
export const createHarnessProcessSupervisor = (options: HarnessProcessSupervisorOptions) =>
  Effect.gen(function* () {
    const journal = yield* createJournal(options);
    const work = yield* Scope.make();
    const gate = yield* Semaphore.make(1);
    let active: {
      turnId: string;
      done: Deferred.Deferred<HarnessProcessSupervisorOutcome>;
    } | null = null;
    const close = Effect.uninterruptible(
      journal.close.pipe(Effect.ensuring(Scope.close(work, Exit.void))),
    );
    yield* Effect.addFinalizer(() => close.pipe(Effect.ignoreCause));

    const start = (turnId: string, resumeFirst: boolean) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<HarnessProcessSupervisorOutcome>();
        active = { turnId, done };
        yield* executeTurn(options, journal, resumeFirst).pipe(
          Effect.flatMap((result) => Deferred.succeed(done, result)),
          Effect.ensuring(
            Effect.suspend(() => Deferred.succeed(done, blocker(journal.current(), "cancelled"))),
          ),
          Effect.forkIn(work),
        );
        return { wait: Deferred.await(done) };
      });

    const existing = (turnId: string) => {
      if (active?.turnId === turnId && !Deferred.isDoneUnsafe(active.done))
        return Deferred.await(active.done);
      const state = journal.current();
      const completed = state.turns.find((receipt) => receipt.request.turnId === turnId)?.result;
      return Effect.succeed(completed ?? state.blocker ?? blocker(state, "busy"));
    };

    const run = (supplied: HarnessProcessSupervisorTurn) =>
      Effect.gen(function* () {
        const turn = yield* parse(SupervisorTurn, structuredClone(supplied));
        const result = yield* gate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const admitted = yield* admitRun(
                journal,
                turn,
                active !== null && !Deferred.isDoneUnsafe(active.done),
              );
              if (admitted._tag === "Blocker") return { wait: Effect.succeed(admitted) };
              if (admitted._tag === "Existing") return { wait: existing(admitted.turnId) };
              return yield* start(admitted.turnId, admitted.resumeFirst);
            }),
          ),
        );
        return yield* result.wait;
      }).pipe(Effect.onInterrupt(() => close));

    const retry = (supplied: HarnessProcessSupervisorRetry) =>
      Effect.gen(function* () {
        const request = yield* parse(SupervisorRetry, structuredClone(supplied));
        const result = yield* gate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const admitted = yield* admitRetry(
                journal,
                request,
                active !== null && !Deferred.isDoneUnsafe(active.done),
              );
              if (admitted._tag === "Blocker") return { wait: Effect.succeed(admitted) };
              if (admitted._tag === "Existing") return { wait: existing(admitted.turnId) };
              return yield* start(admitted.turnId, admitted.resumeFirst);
            }),
          ),
        );
        return yield* result.wait;
      }).pipe(Effect.onInterrupt(() => close));

    return { run, retry, close, snapshot: Effect.sync(() => journal.current()) };
  });
