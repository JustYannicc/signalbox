import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as TxRef from "effect/TxRef";

import { forkParked } from "../serverActivation.ts";

/**
 * Which runs need replaying, and when the engine is idle. A run replays once
 * at a time; different runs replay side by side, so one slow replay never
 * holds up the rest. Asking for a run that is replaying queues it once more
 * for after.
 *
 * `busy` counts queued replays plus whatever else callers count (running
 * steps, queued event work). A step enqueues its run's replay before it stops
 * counting, and a replay starts its steps before it does, so zero means idle.
 */

/** Runs replayed at once. */
const REPLAY_CONCURRENCY = 4;
/** Replays that fail for reasons outside the code (storage, sandbox) are tried this often. */
const REPLAY_ATTEMPTS = 5;

export const makeReplayQueue = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<string>();
  const queued = new Set<string>();
  const replaying = new Set<string>();
  /** Asked for again while replaying; counted as busy from then. */
  const again = new Set<string>();
  const busy = yield* TxRef.make(0);
  /** Replays that failed outside the code, with when to try again. */
  const retries = new Map<string, { readonly failures: number; readonly at: number }>();

  const adjustBusy = (delta: number) =>
    TxRef.update(busy, (count) => count + delta).pipe(Effect.tx);

  const enqueue = (runId: string) =>
    Effect.suspend(() => {
      if (queued.has(runId) || again.has(runId)) return Effect.void;
      if (replaying.has(runId)) {
        again.add(runId);
        return adjustBusy(1);
      }
      queued.add(runId);
      return adjustBusy(1).pipe(Effect.andThen(Queue.offer(queue, runId)), Effect.asVoid);
    });

  const finished = (runId: string) =>
    Effect.suspend(() => {
      replaying.delete(runId);
      if (!again.delete(runId)) return adjustBusy(-1);
      // Queued before this replay stops counting, so the engine never looks idle in between.
      queued.add(runId);
      return Queue.offer(queue, runId).pipe(Effect.andThen(adjustBusy(-1)));
    });

  const worker = (replay: (runId: string) => Effect.Effect<void>) =>
    Queue.take(queue).pipe(
      Effect.flatMap((runId) =>
        Effect.suspend(() => {
          queued.delete(runId);
          replaying.add(runId);
          return replay(runId).pipe(Effect.ensuring(finished(runId)));
        }),
      ),
      Effect.forever,
    );

  return {
    enqueue,
    adjustBusy,
    /** Waits until nothing is queued, replaying or otherwise counted as busy. */
    drain: TxRef.get(busy).pipe(
      Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
      Effect.asVoid,
    ),
    /** Starts the workers that replay queued runs with `replay`. */
    start: (
      replay: (runId: string) => Effect.Effect<void>,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.forEach(Array.from({ length: REPLAY_CONCURRENCY }), () => forkParked(worker(replay)), {
        discard: true,
      }),
    /**
     * Records a replay that failed outside the code. True while it should be
     * tried again (with backoff, by `retryDue`); false once attempts ran out.
     */
    failed: (runId: string, now: number) =>
      Effect.sync(() => {
        const failures = (retries.get(runId)?.failures ?? 0) + 1;
        if (failures >= REPLAY_ATTEMPTS) {
          retries.delete(runId);
          return { retry: false, failures } as const;
        }
        retries.set(runId, { failures, at: now + 1_000 * 2 ** (failures - 1) });
        return { retry: true, failures } as const;
      }),
    /** Forgets a run's failed replays: it replayed, or it ended. */
    forget: (runId: string) => Effect.sync(() => retries.delete(runId)),
    /** Queues the failed replays whose backoff ended by `now`. */
    retryDue: (now: number) =>
      Effect.forEach(
        [...retries].filter(([, retry]) => retry.at <= now),
        ([runId]) => enqueue(runId),
        { discard: true },
      ),
  };
});

export type ReplayQueue = Effect.Success<typeof makeReplayQueue>;
