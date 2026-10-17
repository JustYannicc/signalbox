import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";

describe("dependency progress at the end of a run", () => {
  it.effect.each(["stop", "failure", "completion", "lost", "recovery"] as const)(
    "settles unfinished setup on %s and ignores late progress",
    (ending) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          const progress: RunnerItem = {
            kind: "dependencies.progress",
            runId: turn.runId,
            root: "app",
            status: "installing",
            message: "Installing dependencies in app/.",
          };
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [
              ...(ending === "recovery" ? [report.started] : []),
              progress,
              { ...progress, root: "ready", status: "installed", message: "Ready." },
            ],
          });
          const setupRow = () =>
            Effect.map(snapshot(engine), ({ projection }) =>
              projection.turnItems.find(
                (item) => item.id === `turn-item:${turn.runId}:dependencies:app`,
              ),
            );
          expect(yield* setupRow()).toMatchObject({ status: "running", completedAt: null });

          if (ending === "stop") {
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("stop-setup"),
                threadId,
                runId: turn.runId,
                holdQueue: true,
              },
              personal,
            );
          } else if (ending === "lost" || ending === "recovery") {
            yield* runner.ended(machine.generation, "Lost during dependency setup.");
          } else {
            yield* runner.batch({
              generation: machine.generation,
              sequence: 2,
              items:
                ending === "failure"
                  ? [{ kind: "turn.failed", runId: turn.runId, message: "Setup failed." }]
                  : [report.started, report.terminal],
            });
          }

          const settled = yield* setupRow();
          expect(settled).toMatchObject({
            status: ending === "failure" ? "failed" : "interrupted",
            completedAt: expect.anything(),
          });
          yield* runner.batch({
            generation: machine.generation,
            sequence: ending === "stop" ? 2 : 3,
            items: [{ ...progress, status: "installed", message: "Late success." }],
          });
          expect(yield* setupRow()).toEqual(settled);
          expect(
            (yield* snapshot(engine)).projection.turnItems.find(
              (item) => item.id === `turn-item:${turn.runId}:dependencies:ready`,
            ),
          ).toMatchObject({ status: "completed", summary: "Ready." });
        }),
      ),
  );
});
