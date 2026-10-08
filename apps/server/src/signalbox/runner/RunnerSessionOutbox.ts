import { MAX_APPEND_BYTES } from "@signalbox/runner-protocol/SessionProtocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { SessionClient, SessionClientError } from "./RunnerSessionClient.ts";

/**
 * The machine's side of its session store: every stream's rows, in the order
 * the harness wrote them, on their way to the thread. Rows are queued in
 * memory and sent one batch at a time per stream, each at the offset the
 * store should already hold, so the store only ever holds a gapless prefix.
 * A failed send is retried until it lands; rows are never dropped while the
 * machine lives, and queuing never waits on the network.
 *
 * Positions (`enqueue`, `reach`) count the rows this machine queued on a
 * stream, not the store's rows: the store may hold rows from before.
 *
 * A stream whose sending makes no progress for `stallAfterMs` is reported
 * once through `onFailure` (the Runner stops the turn rather than run ahead
 * of what would survive the machine), and keeps trying. A stream the store
 * refuses for good (a gap, or a request it rejects) is reported and given up.
 */

export class SessionNotSavedError extends Schema.TaggedError<SessionNotSavedError>()(
  "SessionNotSavedError",
  { message: Schema.String },
) {}

export interface SessionOutbox {
  /** Queues `rows` after everything already queued on `stream`; answers the position they end at. */
  readonly enqueue: (stream: string, rows: ReadonlyArray<string>) => Effect.Effect<number>;
  /**
   * Waits until this machine's rows of `stream` up to `position` are durable.
   * Giving up after `waitMs` fails the wait, never the rows: they stay queued.
   */
  readonly reach: (
    stream: string,
    position: number,
    waitMs: number,
  ) => Effect.Effect<void, SessionNotSavedError>;
  /** Waits until everything queued on `stream` so far is durable. */
  readonly settled: (stream: string, waitMs: number) => Effect.Effect<void, SessionNotSavedError>;
  /** Rows of `stream` stored or queued, asking the store the first time. */
  readonly count: (stream: string) => Effect.Effect<number>;
  /** Records that the store holds `count` rows of `stream`, as a restore read them. */
  readonly stored: (stream: string, count: number) => Effect.Effect<void>;
  /** Waits until every queued row is durable, or fails after `waitMs`. */
  readonly drain: (waitMs: number) => Effect.Effect<void, SessionNotSavedError>;
  /** Whether rows are waiting to be stored. */
  readonly pending: Effect.Effect<boolean>;
  /** Whether a stream's sending has stalled or failed and not recovered. */
  readonly stalled: Effect.Effect<boolean>;
}

interface Waiter {
  readonly position: number;
  readonly done: Deferred.Deferred<void, SessionNotSavedError>;
}

interface StreamState {
  /** Rows the store held before this machine's; null until asked. */
  base: number | null;
  /** This machine's rows that are durable. */
  sent: number;
  readonly queued: Array<string>;
  readonly waiters: Array<Waiter>;
  sending: boolean;
  /** When sending last failed with no progress since; null while it works. */
  stuckSince: number | null;
  reported: boolean;
  /** Why the store refused this stream for good. */
  dead: string | null;
}

/** Retry backoff: 250 ms, doubling, at most 5 s. */
const retryDelay = (attempt: number) => Math.min(250 * 2 ** attempt, 5_000);

/** A refusal retrying cannot change: the request itself is wrong, or this machine was replaced. */
const isFatal = (error: SessionClientError) =>
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

/** The rows at the head of `queued` that fit one request, at least one. */
const nextBatch = (queued: ReadonlyArray<string>) => {
  let bytes = 0;
  let count = 0;
  for (const row of queued) {
    bytes += row.length * 3;
    if (count > 0 && bytes > MAX_APPEND_BYTES) break;
    count += 1;
  }
  return queued.slice(0, count);
};

const NOT_SAVED = "This turn's session could not be saved, so it was stopped.";

export const makeSessionOutbox = Effect.fn("makeSessionOutbox")(function* (input: {
  readonly client: SessionClient;
  readonly stallAfterMs: number;
  readonly onFailure: (message: string) => Effect.Effect<void>;
}): Effect.fn.Return<SessionOutbox, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const streams = new Map<string, StreamState>();

  const stateOf = (stream: string) => {
    let state = streams.get(stream);
    if (state === undefined) {
      state = {
        base: null,
        sent: 0,
        queued: [],
        waiters: [],
        sending: false,
        stuckSince: null,
        reported: false,
        dead: null,
      };
      streams.set(stream, state);
    }
    return state;
  };

  /** Gives `stream` up: its rows are dropped from the queue and every wait on it fails. */
  const kill = (state: StreamState, reason: string) =>
    Effect.gen(function* () {
      state.dead = reason;
      state.queued.splice(0);
      if (!state.reported) {
        state.reported = true;
        yield* input.onFailure(NOT_SAVED);
      }
      for (const waiter of state.waiters.splice(0)) {
        yield* Deferred.fail(waiter.done, new SessionNotSavedError({ message: reason }));
      }
    });

  /**
   * Retries `effect` for `stream` until it succeeds, reporting a stall once it
   * has failed for long enough. Null when the store refused the stream for good.
   */
  const persist = <A>(
    stream: string,
    state: StreamState,
    effect: Effect.Effect<A, SessionClientError>,
  ) =>
    Effect.gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const exit = yield* Effect.exit(effect);
        const now = yield* Clock.currentTimeMillis;
        if (exit._tag === "Success") {
          state.stuckSince = null;
          state.reported = false;
          return exit.value;
        }
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        if (error !== undefined && isFatal(error)) {
          yield* Effect.logError("the session store refused a stream", {
            stream,
            error: error.message,
          });
          yield* kill(state, error.message);
          return null;
        }
        state.stuckSince ??= now;
        if (!state.reported && now - state.stuckSince >= input.stallAfterMs) {
          state.reported = true;
          yield* Effect.logWarning("session rows are not being saved", {
            stream,
            error: error?.message ?? "unknown error",
          });
          yield* input.onFailure(NOT_SAVED);
        }
        yield* Effect.sleep(retryDelay(attempt));
      }
    });

  /** The store's rows before this machine's, asked for once; null when the stream is dead. */
  const baseOf = (stream: string, state: StreamState) =>
    Effect.gen(function* () {
      if (state.base !== null) return state.base;
      const listed = yield* persist(stream, state, input.client.streams(stream));
      if (listed === null) return null;
      // A restore may have recorded it meanwhile.
      state.base ??= (listed.find((entry) => entry.stream === stream)?.count ?? 0) - state.sent;
      return state.base;
    });

  const settle = (state: StreamState) =>
    Effect.gen(function* () {
      const done = state.waiters.filter((waiter) => waiter.position <= state.sent);
      const open = state.waiters.filter((waiter) => waiter.position > state.sent);
      state.waiters.splice(0, state.waiters.length, ...open);
      for (const waiter of done) yield* Deferred.succeed(waiter.done, undefined);
    });

  /** Sends `stream`'s queue until it is empty. One sender per stream at a time. */
  const send = (stream: string, state: StreamState): Effect.Effect<void> =>
    Effect.gen(function* () {
      const base = yield* baseOf(stream, state);
      if (base === null) return;
      while (state.queued.length > 0) {
        const batch = nextBatch(state.queued);
        const offset = base + state.sent;
        const result = yield* persist(
          stream,
          state,
          input.client.append({ stream, offset, rows: batch }),
        );
        if (result === null) return;
        if (result._tag === "gap" || result.count < offset) {
          // The store holds fewer rows than it acknowledged before: nothing
          // this machine still has can fill that gap.
          yield* Effect.logError("the session store lost rows", { stream, offset, result });
          return yield* kill(state, "The session store lost rows.");
        }
        const landed = Math.min(result.count - offset, state.queued.length);
        state.queued.splice(0, landed);
        state.sent += landed;
        yield* settle(state);
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          state.sending = false;
          // Rows queued while the last batch was answered.
          return kick(stream);
        }),
      ),
    );

  const kick = (stream: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const state = stateOf(stream);
      if (state.sending || state.dead !== null || state.queued.length === 0) return Effect.void;
      state.sending = true;
      return Effect.asVoid(send(stream, state).pipe(Effect.forkIn(scope)));
    });

  const enqueue: SessionOutbox["enqueue"] = (stream, rows) =>
    Effect.suspend(() => {
      const state = stateOf(stream);
      if (state.dead === null) state.queued.push(...rows);
      const position = state.sent + state.queued.length;
      return Effect.as(kick(stream), position);
    });

  /** Waits until this machine's rows of `stream` up to `position` are durable. */
  const waitFor = (stream: string, position: number) =>
    Effect.gen(function* () {
      const state = stateOf(stream);
      if (state.sent >= position) return;
      if (state.dead !== null) {
        return yield* new SessionNotSavedError({ message: state.dead });
      }
      const waiter: Waiter = { position, done: yield* Deferred.make<void, SessionNotSavedError>() };
      state.waiters.push(waiter);
      yield* Deferred.await(waiter.done).pipe(
        // A wait given up on leaves nothing behind.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            const index = state.waiters.indexOf(waiter);
            if (index !== -1) state.waiters.splice(index, 1);
          }),
        ),
      );
    });

  const within = (waitMs: number, what: string) =>
    Effect.timeoutOrElse({
      duration: waitMs,
      orElse: () =>
        Effect.fail(new SessionNotSavedError({ message: `${what} were not saved in time.` })),
    });

  const queuedEnd = (state: StreamState) => state.sent + state.queued.length;

  return {
    enqueue,
    reach: (stream, position, waitMs) =>
      waitFor(stream, position).pipe(within(waitMs, `Rows of ${stream}`)),
    settled: (stream, waitMs) =>
      Effect.suspend(() => waitFor(stream, queuedEnd(stateOf(stream)))).pipe(
        within(waitMs, `Rows of ${stream}`),
      ),
    count: (stream) =>
      Effect.gen(function* () {
        const state = stateOf(stream);
        return ((yield* baseOf(stream, state)) ?? 0) + queuedEnd(state);
      }),
    stored: (stream, count) =>
      Effect.sync(() => {
        const state = stateOf(stream);
        if (state.base === null) state.base = count - state.sent;
      }),
    drain: (waitMs) =>
      Effect.suspend(() =>
        Effect.forEach(
          [...streams.entries()].filter(([, state]) => state.queued.length > 0),
          ([stream, state]) => waitFor(stream, queuedEnd(state)),
          { discard: true },
        ),
      ).pipe(within(waitMs, "The session's rows")),
    pending: Effect.sync(() => [...streams.values()].some((state) => state.queued.length > 0)),
    stalled: Effect.sync(() => [...streams.values()].some((state) => state.reported)),
  } satisfies SessionOutbox;
});
