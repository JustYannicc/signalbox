import type {
  RunnerItem,
  RunnerMessage,
  RunnerTurn,
  ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { makeRunnerSession, RunnerConnectionError, type RunnerTransport } from "./RunnerSession.ts";
import type { RunnerTurns } from "./RunnerTurns.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");
const turn = { runId } as RunnerTurn;

const item = (label: string): RunnerItem => ({
  kind: "provider",
  runId,
  event: { type: "turn_item.updated", label },
});

/**
 * A thread that behaves like the Durable Object's side: it commits a batch
 * once, acknowledges after committing, and answers `hello` with the last batch
 * it committed. `dropAfterCommit` loses the next acknowledgement with the
 * socket, the case a resend must not duplicate.
 */
const makeFakeThread = Effect.gen(function* () {
  const committed = yield* Ref.make<ReadonlyArray<RunnerItem>>([]);
  const acked = yield* Ref.make(0);
  const hellos = yield* Ref.make<ReadonlyArray<number>>([]);
  const dropAfterCommit = yield* Ref.make(false);
  const toRunner = yield* Ref.make<Queue.Queue<ThreadMessage, RunnerConnectionError> | null>(null);
  const closed = new RunnerConnectionError({ message: "closed" });

  const transport: RunnerTransport = {
    connect: Effect.gen(function* () {
      const inbox = yield* Queue.unbounded<ThreadMessage, RunnerConnectionError>();
      const open = yield* Ref.make(true);
      yield* Ref.set(toRunner, inbox);
      const close = Ref.set(open, false).pipe(
        Effect.andThen(Queue.fail(inbox, closed)),
        Effect.asVoid,
      );
      const reply = (message: ThreadMessage) => Effect.asVoid(Queue.offer(inbox, message));
      const send = (message: RunnerMessage): Effect.Effect<void, RunnerConnectionError> =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(open))) return yield* closed;
          switch (message.type) {
            case "hello":
              yield* Ref.update(hellos, (all) => [...all, message.lastAckedSequence]);
              yield* reply({
                type: "welcome",
                generation: message.generation,
                ackedSequence: yield* Ref.get(acked),
                activeRunId: runId,
              });
              return;
            case "batch": {
              const last = yield* Ref.get(acked);
              if (message.sequence > last + 1) return yield* close;
              if (message.sequence === last + 1) {
                yield* Ref.update(committed, (all) => [...all, ...message.items]);
                yield* Ref.set(acked, message.sequence);
              }
              if (yield* Ref.getAndSet(dropAfterCommit, false)) return yield* close;
              yield* reply({ type: "ack", sequence: message.sequence });
              return;
            }
            case "end":
              return yield* close;
          }
        });
      return { send, receive: Queue.take(inbox), close };
    }),
  };

  const toCurrent = (message: ThreadMessage) =>
    Effect.flatMap(Ref.get(toRunner), (inbox) =>
      inbox === null ? Effect.void : Effect.asVoid(Queue.offer(inbox, message)),
    );

  return { transport, committed, acked, hellos, dropAfterCommit, toCurrent };
});

/** A harness whose reports the test writes by hand. */
const makeFakeTurns = Effect.gen(function* () {
  const emitRef = yield* Deferred.make<(item: RunnerItem) => Effect.Effect<void>>();
  const startedTurns = yield* Ref.make<ReadonlyArray<RunId>>([]);
  const make = (emit: (item: RunnerItem) => Effect.Effect<void>) =>
    Effect.as(Deferred.succeed(emitRef, emit), {
      start: (next) => Ref.update(startedTurns, (all) => [...all, next.runId]),
      interrupt: () => Effect.void,
      keepOnly: () => Effect.void,
    } satisfies RunnerTurns);
  const emit = (reported: RunnerItem) =>
    Effect.flatMap(Deferred.await(emitRef), (send) => send(reported));
  return { make, emit, startedTurns };
});

/** Lets the session's fibers run until `done` holds, advancing the test clock past reconnect waits. */
const settle = (done: Effect.Effect<boolean>, label = "") =>
  Effect.gen(function* () {
    for (let round = 0; round < 50; round++) {
      if (yield* done) return;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
    }
    throw new Error(`the session never settled: ${label}`);
  });

describe("RunnerSession", () => {
  it.effect("resends after a dropped socket without delivering anything twice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeFakeThread;
        const turns = yield* makeFakeTurns;
        yield* makeRunnerSession({
          threadId,
          generation: 1,
          token: "token",
          machineId: "machine",
          imageVersion: "test",
          transport: thread.transport,
          makeTurns: turns.make,
        });
        yield* settle(
          Effect.map(Ref.get(thread.hellos), (all) => all.length === 1),
          "first hello",
        );
        yield* thread.toCurrent({ type: "turn.start", turn, modelToken: "model-token" });
        yield* settle(
          Effect.map(Ref.get(turns.startedTurns), (all) => all.length === 1),
          "turn started",
        );

        yield* turns.emit(item("a"));
        yield* settle(
          Effect.map(Ref.get(thread.acked), (acked) => acked === 1),
          "first batch acked",
        );

        // The thread commits "b" but the socket dies before its ack goes out.
        yield* Ref.set(thread.dropAfterCommit, true);
        yield* turns.emit(item("b"));
        yield* turns.emit(item("c"));
        yield* settle(
          Effect.map(Ref.get(thread.hellos), (all) => all.length === 2),
          "reconnected",
        );
        yield* settle(
          Effect.map(Ref.get(thread.committed), (all) => all.length >= 3),
          "all committed",
        );
        // Give a stray resend every chance to arrive.
        for (let round = 0; round < 5; round++) yield* TestClock.adjust("1 second");

        const labels = (yield* Ref.get(thread.committed)).map((reported) =>
          reported.kind === "provider" ? reported.event.label : reported.kind,
        );
        expect(labels).toEqual(["a", "b", "c"]);
        // The reconnect said hello with what the Runner last saw acknowledged.
        expect(yield* Ref.get(thread.hellos)).toEqual([0, 1]);
      }),
    ),
  );

  it.effect("ends when the thread refuses it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* makeFakeTurns;
        const session = yield* makeRunnerSession({
          threadId,
          generation: 1,
          token: "token",
          machineId: "machine",
          imageVersion: "test",
          transport: {
            connect: Effect.gen(function* () {
              const inbox = yield* Queue.unbounded<ThreadMessage, RunnerConnectionError>();
              return {
                send: () =>
                  Effect.asVoid(
                    Queue.offer(inbox, {
                      type: "refused",
                      reason: "stale_generation",
                      message: "A newer machine replaced this one.",
                    }),
                  ),
                receive: Queue.take(inbox),
                close: Effect.void,
              };
            }),
          },
          makeTurns: turns.make,
        });
        expect(yield* session.ended).toContain("stale_generation");
      }),
    ),
  );
});
