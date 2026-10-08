import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerItem,
  type RunnerMessage,
  type ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { RunnerTurns } from "./RunnerTurns.ts";

/**
 * One thread's Runner: its connection to the thread's object and the
 * sequenced outbox behind it. What the harness reports becomes numbered
 * batches that stay in the outbox until the thread acknowledges them, so a
 * dropped socket loses nothing. Each reconnect says `hello` with the last
 * acknowledged batch, and once the thread answers with the last batch it
 * committed, everything after it is sent again in order. The thread ignores
 * anything it already has, so nothing arrives twice.
 */

export class RunnerConnectionError extends Schema.TaggedError<RunnerConnectionError>()(
  "RunnerConnectionError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** One open connection to the thread. `receive` fails once it closes. */
export interface RunnerConnection {
  readonly send: (message: RunnerMessage) => Effect.Effect<void, RunnerConnectionError>;
  readonly receive: Effect.Effect<ThreadMessage, RunnerConnectionError>;
  readonly close: Effect.Effect<void>;
}

/** Opens connections; each lives as long as the scope it was opened in. */
export interface RunnerTransport {
  readonly connect: Effect.Effect<RunnerConnection, RunnerConnectionError, Scope.Scope>;
}

export interface RunnerSessionInput {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly token: string;
  readonly machineId: string;
  readonly imageVersion: string;
  readonly transport: RunnerTransport;
  /** Builds the turn driver once the session can take its reports. */
  readonly makeTurns: (
    emit: (item: RunnerItem) => Effect.Effect<void>,
  ) => Effect.Effect<RunnerTurns, never, Scope.Scope>;
}

export interface RunnerSession {
  /** Why the session ended: the thread said `end`, refused it, or stayed unreachable. */
  readonly ended: Effect.Effect<string>;
  /** Closes the current socket, as a network drop would. The session reconnects. */
  readonly dropConnection: Effect.Effect<void>;
}

interface Batch {
  readonly sequence: number;
  readonly items: ReadonlyArray<RunnerItem>;
}

/** Most items in one batch. */
const MAX_BATCH_ITEMS = 256;
/** Reconnect backoff: 250 ms, doubling, at most 5 s. */
const reconnectDelay = (failures: number) => Math.min(250 * 2 ** failures, 5_000);
/** A thread unreachable for this long has no use for this machine. */
const GIVE_UP_AFTER_MS = 5 * 60_000;

export const makeRunnerSession = Effect.fn("makeRunnerSession")(function* (
  input: RunnerSessionInput,
): Effect.fn.Return<RunnerSession, never, Scope.Scope> {
  const items = yield* Queue.unbounded<RunnerItem>();
  const ended = yield* Deferred.make<string>();
  // Outbox order is wire order: appending and (re)sending share one lock.
  const wire = yield* Semaphore.make(1);
  const outbox = yield* Ref.make<{
    readonly acked: number;
    readonly next: number;
    readonly pending: ReadonlyArray<Batch>;
  }>({ acked: 0, next: 1, pending: [] });
  const current = yield* Ref.make<RunnerConnection | null>(null);
  /** Whether the latest connection got as far as `welcome`. */
  const welcomed = yield* Ref.make(false);

  // Closing the session's scope (a newer generation replaced it) ends it too.
  yield* Effect.addFinalizer(() => Deferred.succeed(ended, "stopped"));
  const turns = yield* input.makeTurns((item) => Effect.asVoid(Queue.offer(items, item)));

  const sendNow = (connection: RunnerConnection, batch: Batch) =>
    connection
      .send({ type: "batch", sequence: batch.sequence, items: batch.items })
      // A failed send means the socket is going; the reconnect resends.
      .pipe(Effect.ignore);

  // Batches whatever the harness reported since the last one.
  yield* Effect.forever(
    Effect.gen(function* () {
      const reported = yield* Queue.takeBetween(items, 1, MAX_BATCH_ITEMS);
      yield* wire.withPermits(1)(
        Effect.gen(function* () {
          const batch = yield* Ref.modify(outbox, (state) => {
            const next: Batch = { sequence: state.next, items: reported };
            return [next, { ...state, next: state.next + 1, pending: [...state.pending, next] }];
          });
          const connection = yield* Ref.get(current);
          if (connection !== null) yield* sendNow(connection, batch);
        }),
      );
    }),
  ).pipe(Effect.forkScoped);

  const acknowledge = (sequence: number) =>
    Ref.update(outbox, (state) => ({
      ...state,
      acked: Math.max(state.acked, sequence),
      pending: state.pending.filter((batch) => batch.sequence > sequence),
    }));

  const handle = (connection: RunnerConnection, message: ThreadMessage) => {
    switch (message.type) {
      case "ack":
        return acknowledge(message.sequence);
      case "turn.start":
        return turns.start(message.turn, message.modelToken, message.drive);
      case "interrupt":
        return turns.interrupt(message.runId);
      case "end":
        return Deferred.succeed(ended, message.reason).pipe(Effect.andThen(connection.close));
      default:
        return Effect.void;
    }
  };

  /** One connection, from `hello` until it closes. */
  const connectOnce = Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* input.transport.connect;
      const { acked } = yield* Ref.get(outbox);
      yield* connection.send({
        type: "hello",
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        imageVersion: input.imageVersion,
        machineId: input.machineId,
        threadId: input.threadId,
        generation: input.generation,
        token: input.token,
        lastAckedSequence: acked,
      });
      const answer = yield* connection.receive;
      if (answer.type === "refused") {
        yield* Deferred.succeed(ended, `refused (${answer.reason}): ${answer.message}`);
        return;
      }
      if (answer.type !== "welcome") {
        return yield* new RunnerConnectionError({
          message: `Expected welcome, got ${answer.type}.`,
        });
      }
      yield* acknowledge(answer.ackedSequence);
      yield* Ref.set(welcomed, true);
      yield* Effect.logInfo("runner connected", {
        threadId: input.threadId,
        ackedSequence: answer.ackedSequence,
        resending: (yield* Ref.get(outbox)).pending.length,
      });
      // Turns the thread stopped while this machine was away.
      yield* turns.keepOnly(answer.activeRunId);
      yield* wire.withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.set(current, connection);
          for (const batch of (yield* Ref.get(outbox)).pending) yield* sendNow(connection, batch);
        }),
      );
      yield* Effect.addFinalizer(() => Ref.set(current, null));
      while (true) yield* handle(connection, yield* connection.receive);
    }),
  );

  // Connects, and reconnects after every drop until the thread lets the machine go.
  yield* Effect.gen(function* () {
    let failures = 0;
    let lastConnectedAt = yield* Clock.currentTimeMillis;
    while (!(yield* Deferred.isDone(ended))) {
      yield* Ref.set(welcomed, false);
      const exit = yield* Effect.exit(connectOnce);
      if (yield* Deferred.isDone(ended)) return;
      const now = yield* Clock.currentTimeMillis;
      const wasWelcomed = yield* Ref.get(welcomed);
      if (wasWelcomed) lastConnectedAt = now;
      yield* Effect.logInfo("runner connection closed", {
        threadId: input.threadId,
        ...(exit._tag === "Failure" ? { cause: Cause.pretty(exit.cause).split("\n")[0] } : {}),
      });
      if (now - lastConnectedAt >= GIVE_UP_AFTER_MS) {
        yield* Deferred.succeed(ended, "The thread stayed unreachable.");
        return;
      }
      failures = wasWelcomed ? 0 : failures + 1;
      yield* Effect.sleep(reconnectDelay(failures));
    }
  }).pipe(Effect.forkScoped);

  return {
    ended: Deferred.await(ended),
    dropConnection: Effect.flatMap(Ref.get(current), (connection) =>
      connection === null ? Effect.void : connection.close,
    ),
  };
});
