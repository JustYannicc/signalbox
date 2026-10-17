import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { DRAIN_TIMEOUT_MS } from "./ThreadRunner.ts";
import {
  connect,
  freshDatabase,
  hello,
  launch,
  liveTurn,
  owner,
  personal,
  threadId,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";

describe("cloud lifecycle machine release", () => {
  it.effect.each(["thread.archive", "thread.settle"] as const)(
    "%s waits for a preview-only machine to connect and save",
    (type) => {
      const previews = { held: false, lastActiveAt: null };
      return withObject(
        freshDatabase(),
        (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const first = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: first.generation,
              sequence: 1,
              items: [report.started, report.full, report.terminal],
            });
            yield* runner.ended(first.generation, "The first machine stopped.");
            previews.held = true;
            const requested = yield* runner.reconcile;
            const machine = requested.ensure!;
            yield* runner.ensured(machine.generation);
            expect(yield* runner.previewDrive).not.toBeNull();
            yield* engine.dispatch(
              owner,
              { type, commandId: CommandId.make("close-preview-boot"), threadId },
              personal,
            );
            yield* TestClock.adjust(120_000);
            const waiting = yield* runner.reconcile;
            expect(waiting.release).toBeNull();
            expect(waiting.stop).toBe(false);
            expect(yield* runner.leaseToken(machine.generation)).toBe(machine.token);
            yield* runner.hello(hello(machine.generation, machine.token));
            const asked = yield* runner.reconcile;
            expect(asked.drain).toMatchObject({ generation: machine.generation });
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [{ kind: "machine.drained", id: asked.drain!.id, unsaved: [] }],
            });
            expect((yield* runner.reconcile).release).toBe(machine.generation);
            expect((yield* runner.reconcile).ensure).toBeNull();
          }),
        { previews, drives: true },
      );
    },
  );
  it.effect.each(["thread.archive", "thread.settle"] as const)(
    "%s keeps a disconnected machine until its save is confirmed",
    (type) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.full, report.terminal],
          });
          yield* engine.dispatch(
            owner,
            { type, commandId: CommandId.make("close-disconnected"), threadId },
            personal,
          );
          expect((yield* runner.reconcile).drain).not.toBeNull();
          yield* runner.disconnected({
            generation: machine.generation,
            connection: 1,
            detail: "1006",
          });
          yield* TestClock.adjust(120_000);
          const disconnected = yield* runner.reconcile;
          expect(disconnected.release).toBeNull();
          expect(disconnected.stop).toBe(false);
          expect(yield* runner.leaseToken(machine.generation)).toBe(machine.token);
          yield* runner.hello(hello(machine.generation, machine.token));
          const retry = yield* runner.reconcile;
          expect(retry.drain).not.toBeNull();
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [{ kind: "machine.drained", id: retry.drain!.id, unsaved: [] }],
          });
          expect((yield* runner.reconcile).release).toBe(machine.generation);
        }),
      ),
  );
  it.effect.each(["thread.archive", "thread.settle"] as const)(
    "%s releases only after a saved drain, even with a preview open",
    (type) => {
      const previews = { held: false, lastActiveAt: null };
      return withObject(
        freshDatabase(),
        (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [report.started, report.full, report.terminal],
            });
            previews.held = true;
            yield* engine.dispatch(
              owner,
              { type, commandId: CommandId.make("close"), threadId },
              personal,
            );
            const asked = yield* runner.reconcile;
            expect(asked).toMatchObject({
              release: null,
              drain: { generation: machine.generation },
            });
            yield* TestClock.adjust(DRAIN_TIMEOUT_MS);
            const timeout = yield* runner.reconcile;
            expect(timeout.release).toBeNull();
            expect(timeout.drain!.id).not.toBe(asked.drain!.id);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 2,
              items: [
                {
                  kind: "machine.drained",
                  id: timeout.drain!.id,
                  unsaved: ["Files are still saving"],
                },
              ],
            });
            yield* TestClock.adjust(1);
            const retry = yield* runner.reconcile;
            expect(retry.release).toBeNull();
            expect(yield* runner.leaseToken(machine.generation)).toBe(machine.token);
            expect((yield* runner.work).needsUpkeep).toBe(false);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 3,
              items: [{ kind: "machine.drained", id: retry.drain!.id, unsaved: [] }],
            });
            expect((yield* runner.reconcile).release).toBe(machine.generation);
            expect(yield* runner.leaseToken(machine.generation)).toBeNull();
            expect((yield* runner.reconcile).ensure).toBeNull();
            expect((yield* runner.work).needsUpkeep).toBe(false);
            const snapshot = yield* engine.snapshot(owner);
            expect(snapshot.projection.turnItems).toContainEqual(
              expect.objectContaining({
                type: "assistant_message",
                text: "Hello!",
                status: "completed",
              }),
            );
          }),
        { previews },
      );
    },
  );
});
