import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  send,
  snapshot,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";

const time = (iso: string) => Date.parse(iso);
const epoch = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

describe("run work timing", () => {
  it.effect(
    "counts setup, preserves it through recovery, and gives later turns their own start",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const setupStartedAt = time("2026-10-17T12:00:00Z");
          yield* TestClock.setTime(setupStartedAt);
          yield* launch(engine);
          expect(epoch((yield* engine.summary(owner))?.shell.activityRunStartedAt)).toBe(
            setupStartedAt,
          );

          const machine = yield* connect(runner);
          const firstTurn = yield* liveTurn(runner);
          const firstReport = turnReport(
            firstTurn.runId,
            firstTurn.runOrdinal,
            firstTurn.providerThread,
          );

          // Dependency preparation happens after the run was handed out but before
          // the provider says its turn has started. It belongs to elapsed work.
          const providerStartedAt = time("2026-10-17T12:00:12Z");
          yield* TestClock.setTime(providerStartedAt);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [firstReport.started],
          });
          let { projection } = yield* snapshot(engine);
          expect(epoch(projection.runs[0]?.workStartedAt)).toBe(setupStartedAt);
          expect(epoch(projection.runs[0]?.startedAt)).toBe(providerStartedAt);
          expect(epoch((yield* engine.summary(owner))?.shell.activityRunStartedAt)).toBe(
            setupStartedAt,
          );

          // Losing the machine carries the original start into the continuation.
          const recoveryAt = time("2026-10-17T12:00:20Z");
          yield* TestClock.setTime(recoveryAt);
          yield* runner.ended(machine.generation, "test recovery");
          ({ projection } = yield* snapshot(engine));
          expect(projection.runs.map((run) => epoch(run.workStartedAt))).toEqual([
            setupStartedAt,
            setupStartedAt,
          ]);
          expect(epoch((yield* engine.summary(owner))?.shell.activityRunStartedAt)).toBe(
            setupStartedAt,
          );

          const recoveredMachine = yield* connect(runner);
          const recoveredTurn = yield* liveTurn(runner);
          const recoveredReport = turnReport(
            recoveredTurn.runId,
            recoveredTurn.runOrdinal,
            recoveredTurn.providerThread,
          );
          yield* TestClock.setTime(time("2026-10-17T12:00:25Z"));
          yield* runner.batch({
            generation: recoveredMachine.generation,
            sequence: 1,
            items: [recoveredReport.started],
          });
          yield* TestClock.setTime(time("2026-10-17T12:00:30Z"));
          yield* runner.batch({
            generation: recoveredMachine.generation,
            sequence: 2,
            items: [recoveredReport.full, recoveredReport.terminal],
          });

          const nextTurnStartedAt = time("2026-10-17T12:00:40Z");
          yield* TestClock.setTime(nextTurnStartedAt);
          yield* send(engine, 2, "A later turn");
          ({ projection } = yield* snapshot(engine));
          expect(projection.runs.map((run) => epoch(run.workStartedAt))).toEqual([
            setupStartedAt,
            setupStartedAt,
            nextTurnStartedAt,
          ]);
          expect(epoch((yield* engine.summary(owner))?.shell.activityRunStartedAt)).toBe(
            nextTurnStartedAt,
          );
        }),
      ),
  );

  it.effect("starts queued work after its wait, so queue time is excluded", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const firstStartedAt = time("2026-10-17T13:00:00Z");
        yield* TestClock.setTime(firstStartedAt);
        yield* launch(engine);
        const machine = yield* connect(runner);
        const firstTurn = yield* liveTurn(runner);
        const firstReport = turnReport(
          firstTurn.runId,
          firstTurn.runOrdinal,
          firstTurn.providerThread,
        );
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [firstReport.started],
        });

        const queuedAt = time("2026-10-17T13:00:10Z");
        yield* TestClock.setTime(queuedAt);
        yield* send(engine, 2, "Wait behind the current turn");
        let { projection } = yield* snapshot(engine);
        expect(epoch(projection.runs[1]?.requestedAt)).toBe(queuedAt);
        expect(projection.runs[1]?.workStartedAt).toBeUndefined();
        expect(epoch((yield* engine.summary(owner))?.shell.activityRunStartedAt)).toBe(
          firstStartedAt,
        );

        const dequeuedAt = time("2026-10-17T13:00:30Z");
        yield* TestClock.setTime(dequeuedAt);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 2,
          items: [firstReport.full, firstReport.terminal],
        });
        ({ projection } = yield* snapshot(engine));
        expect(epoch(projection.runs[1]?.requestedAt)).toBe(queuedAt);
        expect(epoch(projection.runs[1]?.workStartedAt)).toBe(dequeuedAt);
        expect(epoch((yield* engine.summary(owner))?.shell.activityRunStartedAt)).toBe(dequeuedAt);
      }),
    ),
  );
});
