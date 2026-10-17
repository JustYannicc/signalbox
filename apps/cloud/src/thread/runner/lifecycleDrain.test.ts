import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { DRAIN_TIMEOUT_MS } from "./ThreadRunner.ts";
import {
  connect,
  freshDatabase,
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
