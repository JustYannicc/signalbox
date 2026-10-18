import type {
  RunnerBuild,
  RunnerItem,
  RunnerMessage,
  RunnerTurn,
  ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import {
  ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
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
const build: RunnerBuild = { imageDigest: null, revision: "abc123", cliVersions: {} };

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
  const runtimeResponseCapabilities = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const helloPulls = yield* Deferred.make<boolean>();
  /** The runs each `hello` said its process holds. */
  const helloRuns = yield* Ref.make<ReadonlyArray<ReadonlyArray<RunId> | undefined>>([]);
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
              yield* Deferred.succeed(helloPulls, message.pulls === true);
              yield* Ref.update(hellos, (all) => [...all, message.lastAckedSequence]);
              yield* Ref.update(runtimeResponseCapabilities, (all) => [
                ...all,
                message.runtimeResponses,
              ]);
              yield* Ref.update(helloRuns, (all) => [...all, message.takenRunIds]);
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

  return {
    transport,
    committed,
    acked,
    hellos,
    runtimeResponseCapabilities,
    helloPulls,
    helloRuns,
    dropAfterCommit,
    toCurrent,
  };
});

/** A harness whose reports the test writes by hand. */
const makeFakeTurns = Effect.gen(function* () {
  const emitRef = yield* Deferred.make<(item: RunnerItem) => Effect.Effect<void>>();
  const startedTurns = yield* Ref.make<ReadonlyArray<RunId>>([]);
  const runtimeResponses = yield* Ref.make<
    ReadonlyArray<Extract<ThreadMessage, { type: "runtime-request.respond" }>>
  >([]);
  /** How often everything was saved for a drain, and what each drain says it couldn't save. */
  const drains = yield* Ref.make(0);
  const unsaved = yield* Ref.make<ReadonlyArray<string>>([]);
  const pullEntered = yield* Deferred.make<string>();
  const finishPull = yield* Deferred.make<void>();
  const make = (emit: (item: RunnerItem) => Effect.Effect<void>) =>
    Effect.as(Deferred.succeed(emitRef, emit), {
      start: (next) => Ref.update(startedTurns, (all) => [...all, next.turn.runId]),
      interrupt: () => Effect.void,
      keepOnly: () => Effect.void,
      steer: () => Effect.void,
      respondRuntimeRequest: (response) =>
        Ref.update(runtimeResponses, (all) => [...all, response]),
      pull: ({ operation }) =>
        Deferred.succeed(pullEntered, operation.id).pipe(
          Effect.andThen(Deferred.await(finishPull)),
          Effect.andThen(
            emit({
              kind: "git.pull.result",
              result: {
                id: operation.id,
                target: operation.target,
                head: operation.expectedThread,
                wip: operation.expectedWip,
                outcome: "up_to_date",
                reason: null,
                hasWorkingTreeChanges: false,
              },
            }),
          ),
          Effect.asVoid,
        ),
      drain: Ref.update(drains, (count) => count + 1).pipe(Effect.andThen(Ref.get(unsaved))),
      taken: Ref.get(startedTurns),
    } satisfies RunnerTurns);
  const emit = (reported: RunnerItem) =>
    Effect.flatMap(Deferred.await(emitRef), (send) => send(reported));
  return {
    make,
    emit,
    startedTurns,
    runtimeResponses,
    drains,
    unsaved,
    pullEntered,
    finishPull,
  };
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

const sessionOf = (
  thread: Effect.Success<typeof makeFakeThread>,
  turns: Effect.Success<typeof makeFakeTurns>,
) =>
  makeRunnerSession({
    threadId,
    generation: 1,
    token: "token",
    machineId: "machine",
    imageVersion: "test",
    build,
    transport: thread.transport,
    makeTurns: turns.make,
  });

describe("RunnerSession", () => {
  it.effect("advertises and forwards runtime responses to the live turn driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeFakeThread;
        const turns = yield* makeFakeTurns;
        yield* sessionOf(thread, turns);
        yield* settle(
          Effect.map(Ref.get(thread.hellos), (all) => all.length === 1),
          "hello",
        );
        const response = {
          type: "runtime-request.respond",
          runId,
          attemptId: RunAttemptId.make("attempt-1"),
          providerSessionId: ProviderSessionId.make("provider-session-1"),
          requestId: RuntimeRequestId.make("request-1"),
          answers: { "question-1": "answer" },
        } as const;

        yield* thread.toCurrent(response);
        yield* settle(
          Effect.map(Ref.get(turns.runtimeResponses), (all) => all.length === 1),
          "runtime response",
        );

        expect(yield* Ref.get(thread.runtimeResponseCapabilities)).toEqual([true]);
        expect(yield* Ref.get(turns.runtimeResponses)).toEqual([response]);
      }),
    ),
  );

  it.effect("keeps receiving while a selected pull is running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeFakeThread;
        const turns = yield* makeFakeTurns;
        yield* sessionOf(thread, turns);
        expect(yield* Deferred.await(thread.helloPulls)).toBe(true);
        yield* settle(
          Effect.map(Ref.get(thread.hellos), (all) => all.length === 1),
          "hello",
        );
        const operation = {
          id: "pull-1",
          target: "a".repeat(40),
          expectedThread: "b".repeat(40),
          expectedWip: null,
          revision: null,
          branch: "threads/thread-1",
        } as const;
        yield* thread.toCurrent({
          type: "git.pull",
          operation,
          drive: { driveId: "drive-1", token: "drive-token", remoteToken: "remote-token" },
        });
        expect(yield* Deferred.await(turns.pullEntered)).toBe("pull-1");

        // A long fetch must not block the next command on this socket.
        yield* thread.toCurrent({ type: "drain", id: 9 });
        yield* settle(
          Effect.map(Ref.get(thread.committed), (all) => all.length === 1),
          "drain while pull runs",
        );
        expect((yield* Ref.get(thread.committed))[0]).toMatchObject({
          kind: "machine.drained",
          id: 9,
        });

        yield* Deferred.succeed(turns.finishPull, undefined);
        yield* settle(
          Effect.map(Ref.get(thread.committed), (all) => all.length === 2),
          "pull result",
        );
        expect((yield* Ref.get(thread.committed))[1]).toMatchObject({
          kind: "git.pull.result",
          result: { id: "pull-1", outcome: "up_to_date" },
        });
      }),
    ),
  );

  it.effect("answers a drain once it saved everything, saying what it couldn't", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeFakeThread;
        const turns = yield* makeFakeTurns;
        yield* sessionOf(thread, turns);
        yield* settle(
          Effect.map(Ref.get(thread.hellos), (all) => all.length === 1),
          "hello",
        );
        yield* Ref.set(turns.unsaved, ["Saving the drive failed: unreachable"]);
        yield* thread.toCurrent({ type: "drain", id: 7 });
        yield* settle(
          Effect.map(Ref.get(thread.committed), (all) => all.length === 1),
          "drained",
        );
        expect(yield* Ref.get(turns.drains)).toBe(1);
        expect(yield* Ref.get(thread.committed)).toEqual([
          { kind: "machine.drained", id: 7, unsaved: ["Saving the drive failed: unreachable"] },
        ]);
      }),
    ),
  );

  it.effect("saves everything before it goes, unless the thread already let it go", () =>
    Effect.gen(function* () {
      const thread = yield* makeFakeThread;
      // Stopped from the machine's side: SIGTERM, a new generation, a new image.
      const stopped = yield* makeFakeTurns;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* sessionOf(thread, stopped);
          yield* settle(
            Effect.map(Ref.get(thread.hellos), (all) => all.length === 1),
            "hello",
          );
        }),
      );
      expect(yield* Ref.get(stopped.drains)).toBe(1);

      // Replaced by a newer generation: the thread let it go first.
      const replaced = yield* makeFakeTurns;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* sessionOf(thread, replaced);
          yield* settle(
            Effect.map(Ref.get(thread.hellos), (all) => all.length === 2),
            "hello",
          );
          yield* session.replaced;
        }),
      );
      expect(yield* Ref.get(replaced.drains)).toBe(0);

      // Let go by the thread: its tokens are gone, there's nothing left to save with.
      const released = yield* makeFakeTurns;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* sessionOf(thread, released);
          yield* settle(
            Effect.map(Ref.get(thread.hellos), (all) => all.length === 3),
            "hello",
          );
          yield* thread.toCurrent({ type: "end", reason: "This machine is no longer needed." });
          yield* session.ended;
        }),
      );
      expect(yield* Ref.get(released.drains)).toBe(0);
    }),
  );

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
          build,
          transport: thread.transport,
          makeTurns: turns.make,
        });
        yield* settle(
          Effect.map(Ref.get(thread.hellos), (all) => all.length === 1),
          "first hello",
        );
        yield* thread.toCurrent({
          type: "turn.start",
          turn,
          modelToken: "model-token",
          drive: null,
          sessions: { token: "sbs1.x.y" },
        });
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
        // The reconnect leaves its own line after what was resent.
        expect(labels).toEqual(["a", "b", "c", "log"]);
        // The reconnect said hello with what the Runner last saw acknowledged.
        expect(yield* Ref.get(thread.hellos)).toEqual([0, 1]);
        // And with the turn it holds, so the thread knows it is still running here.
        expect(yield* Ref.get(thread.helloRuns)).toEqual([[], [runId]]);
      }),
    ),
  );

  // #502: a disk-resumed machine's Runner process was replaced right after the
  // first one reported its turn start. The new process numbered its batches
  // from 1 again, and the thread took them for repeats of what it had.
  it.effect("continues the thread's numbering when a new process takes over the generation", () =>
    Effect.gen(function* () {
      const thread = yield* makeFakeThread;
      const label = (reported: RunnerItem) =>
        reported.kind === "provider" ? reported.event.label : reported.kind;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeFakeTurns;
          yield* makeRunnerSession({
            threadId,
            generation: 1,
            token: "token",
            machineId: "vm:first",
            imageVersion: "test",
            build,
            transport: thread.transport,
            makeTurns: first.make,
          });
          yield* first.emit(item("a"));
          yield* settle(
            Effect.map(Ref.get(thread.acked), (acked) => acked === 1),
            "a acked",
          );
          yield* first.emit(item("b"));
          yield* settle(
            Effect.map(Ref.get(thread.acked), (acked) => acked === 2),
            "b acked",
          );
        }),
      );

      // The replacement reports something before the thread has welcomed it.
      const connect = yield* Deferred.make<void>();
      const second = yield* makeFakeTurns;
      yield* makeRunnerSession({
        threadId,
        generation: 1,
        token: "token",
        machineId: "vm:second",
        imageVersion: "test",
        build,
        transport: {
          connect: Effect.andThen(Deferred.await(connect), thread.transport.connect),
        },
        makeTurns: second.make,
      });
      yield* second.emit(item("x"));
      for (let round = 0; round < 3; round++) yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(connect, undefined);
      yield* settle(
        Effect.map(Ref.get(thread.hellos), (all) => all.length === 2),
        "second hello",
      );
      yield* second.emit(item("y"));
      yield* settle(
        Effect.map(Ref.get(thread.committed), (all) => all.map(label).includes("y")),
        "y committed",
      );

      expect((yield* Ref.get(thread.committed)).map(label)).toEqual(["a", "b", "x", "y"]);
      expect(yield* Ref.get(thread.hellos)).toEqual([0, 0]);
      // #613: the new process holds no turn, so the thread continues the one the first had.
      expect((yield* Ref.get(thread.helloRuns))[1]).toEqual([]);
    }).pipe(Effect.scoped),
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
          build,
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

  it.effect("records how many tries a connection took, once it is welcomed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeFakeThread;
        const turns = yield* makeFakeTurns;
        let attempts = 0;
        yield* makeRunnerSession({
          threadId,
          generation: 1,
          token: "token",
          machineId: "machine",
          imageVersion: "test",
          build,
          transport: {
            connect: Effect.suspend(() =>
              ++attempts <= 2
                ? Effect.fail(new RunnerConnectionError({ message: "network unreachable" }))
                : thread.transport.connect,
            ),
          },
          makeTurns: turns.make,
        });
        yield* settle(
          Effect.map(Ref.get(thread.committed), (all) => all.length === 1),
          "log committed",
        );

        expect(yield* Ref.get(thread.committed)).toEqual([
          {
            kind: "log",
            runId: null,
            level: "info",
            message:
              "connected after 2 failed or dropped connections; last: RunnerConnectionError: network unreachable",
          },
        ]);
      }),
    ),
  );
});
