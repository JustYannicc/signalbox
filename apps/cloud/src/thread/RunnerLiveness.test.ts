import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as RunnerLiveness from "./RunnerLiveness.ts";
import {
  fakeSocket,
  freshDatabase,
  hello,
  hostFor,
  launch,
  liveTurn,
  saveSession,
  sendRunnerFrame,
  snapshot,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

const runningRunner = (
  engine: Parameters<typeof launch>[0],
  runner: Parameters<typeof liveTurn>[0],
  context: Parameters<typeof saveSession>[0],
  sockets: Array<WebSocket>,
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("expected a machine request");
    yield* runner.ensured(plan.ensure.generation);

    const host = yield* hostFor(runner, sockets);
    const socket = fakeSocket();
    sockets.push(socket.socket);
    yield* sendRunnerFrame(host, socket, hello(plan.ensure.generation, plan.ensure.token));

    const turn = yield* liveTurn(runner);
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    yield* sendRunnerFrame(host, socket, {
      type: "batch",
      sequence: 1,
      items: [report.started, report.partial],
    });
    yield* saveSession(context, "claude-session-1");
    return { generation: plan.ensure.generation, token: plan.ensure.token, turn, socket, report };
  });

describe("RunnerLiveness", () => {
  it.effect(
    "keeps a healthy Runner through reconstruction, expires the silent connection, and preserves its ack on reconnect",
    () =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        const sockets: Array<WebSocket> = [];
        const started = yield* withObject(filename, (engine, runner, context) =>
          runningRunner(engine, runner, context, sockets),
        );
        const startedAt = yield* Clock.currentTimeMillis;
        yield* withObject(filename, (_engine, runner) =>
          Effect.gen(function* () {
            const host = yield* hostFor(runner, sockets);
            const wakeAt = yield* Effect.promise(() => RunnerLiveness.inspect(host, startedAt));
            expect(wakeAt).toBe(startedAt + RunnerLiveness.RUNNER_SILENCE_LIMIT_MS);
          }),
        );

        yield* TestClock.adjust("20 seconds");
        const heartbeatAt = yield* Clock.currentTimeMillis;
        yield* withObject(filename, (_engine, runner) =>
          Effect.gen(function* () {
            const host = yield* hostFor(runner, sockets);
            host.recordAutoResponse(started.socket.socket, heartbeatAt - 5_000);
            yield* sendRunnerFrame(host, started.socket, {
              type: "batch",
              sequence: 1,
              items: [started.report.started, started.report.partial],
            });
            const wakeAt = yield* Effect.promise(() => RunnerLiveness.inspect(host, heartbeatAt));
            expect(wakeAt).toBe(heartbeatAt + RunnerLiveness.RUNNER_SILENCE_LIMIT_MS);

            yield* TestClock.adjust("45 seconds");
            const expiredAt = yield* Clock.currentTimeMillis;
            expect(yield* Effect.promise(() => RunnerLiveness.inspect(host, expiredAt))).toBeNull();
            expect(yield* runner.reconcile).toMatchObject({
              wakeAt: expiredAt + 60_000,
              release: null,
            });

            const replacement = fakeSocket();
            sockets.push(replacement.socket);
            yield* sendRunnerFrame(host, replacement, {
              ...hello(started.generation, started.token),
              lastAckedSequence: 1,
              takenRunIds: [started.turn.runId],
            });
            expect(replacement.sent.at(-1)).toMatchObject({
              type: "welcome",
              ackedSequence: 1,
              activeRunId: started.turn.runId,
            });
            yield* sendRunnerFrame(host, started.socket, {
              type: "batch",
              sequence: 2,
              items: [],
            });
            expect(
              started.socket.sent.some(
                (message) => message.type === "ack" && message.sequence === 2,
              ),
            ).toBe(false);

            const now = yield* Clock.currentTimeMillis;
            expect(yield* Effect.promise(() => RunnerLiveness.inspect(host, now))).toBe(
              now + RunnerLiveness.RUNNER_SILENCE_LIMIT_MS,
            );
            expect(yield* runner.reconcile).toMatchObject({ busy: true, release: null });

            yield* TestClock.adjust("45 seconds");
            const replacementExpiredAt = yield* Clock.currentTimeMillis;
            expect(
              yield* Effect.promise(() => RunnerLiveness.inspect(host, replacementExpiredAt)),
            ).toBeNull();
            expect(yield* runner.reconcile).toMatchObject({
              wakeAt: replacementExpiredAt + 60_000,
              release: null,
            });
          }),
        );
      }),
  );

  it.effect(
    "continues a run once after a silent socket and does not extend its recovery deadline",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          const sockets: Array<WebSocket> = [];
          const started = yield* runningRunner(engine, runner, context, sockets);
          const host = yield* hostFor(runner, sockets);

          yield* TestClock.adjust("45 seconds");
          const disconnectedAt = yield* Clock.currentTimeMillis;
          expect(
            yield* Effect.promise(() => RunnerLiveness.inspect(host, disconnectedAt)),
          ).toBeNull();
          const reconnectDeadline = disconnectedAt + 60_000;
          expect(yield* runner.reconcile).toMatchObject({ wakeAt: reconnectDeadline });

          yield* TestClock.adjust("30 seconds");
          const stillWaitingAt = yield* Clock.currentTimeMillis;
          expect(
            yield* Effect.promise(() => RunnerLiveness.inspect(host, stillWaitingAt)),
          ).toBeNull();
          expect(yield* runner.reconcile).toMatchObject({ wakeAt: reconnectDeadline });

          yield* TestClock.adjust("30 seconds");
          expect(yield* runner.reconcile).toMatchObject({
            release: started.generation,
            lost: true,
            stop: true,
          });
          const recoveryAt = yield* Clock.currentTimeMillis;
          expect(yield* Effect.promise(() => RunnerLiveness.inspect(host, recoveryAt))).toBeNull();

          const { projection } = yield* snapshot(engine);
          expect(projection.runs.map((run) => run.status)).toEqual(["interrupted", "starting"]);
          const [interrupted, continuation] = projection.runs;
          expect(continuation?.restartContinuationOfRunId).toBe(interrupted?.id);
          expect(
            projection.turnItems.filter(
              (item) => item.runId === interrupted?.id && item.type === "assistant_message",
            ),
          ).toMatchObject([{ status: "interrupted", text: "Hel" }]);

          expect(yield* runner.reconcile).toMatchObject({
            ensure: { generation: started.generation + 1 },
          });
          expect((yield* snapshot(engine)).projection.runs).toHaveLength(2);
        }),
      ),
  );

  it.effect("lets a Runner's explicit end use the normal continuation path", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const sockets: Array<WebSocket> = [];
        const started = yield* runningRunner(engine, runner, context, sockets);
        const host = yield* hostFor(runner, sockets);

        yield* TestClock.adjust("45 seconds");
        yield* sendRunnerFrame(host, started.socket, { type: "end", reason: "machine stopped" });
        const now = yield* Clock.currentTimeMillis;
        expect(yield* Effect.promise(() => RunnerLiveness.inspect(host, now))).toBeNull();
        expect(yield* runner.reconcile).toMatchObject({
          ensure: { generation: started.generation + 1 },
        });
        expect((yield* snapshot(engine)).projection.runs).toHaveLength(2);
      }),
    ),
  );
});
