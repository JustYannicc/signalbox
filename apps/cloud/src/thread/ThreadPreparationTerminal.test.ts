import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { loadingPreparation } from "./preparationTesting.ts";
import {
  freshDatabase,
  owner,
  personal,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

describe("late preparation failure", () => {
  it.effect.each(["interrupted", "completed"] as const)(
    "does not rewrite an already %s run through the v7 runner socket",
    (status) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, turn, say } = yield* loadingPreparation(engine, runner);
          let sequence = 0;
          if (status === "interrupted") {
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("terminal-stop"),
                threadId,
                runId: target.runId,
                holdQueue: true,
              },
              personal,
            );
          } else {
            yield* say({
              type: "batch",
              sequence: ++sequence,
              items: [{ kind: "preparation.ready", ...target }],
            });
            const reported = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* say({
              type: "batch",
              sequence: ++sequence,
              items: [
                { ...reported.started, preparationGeneration: target.preparationGeneration },
                reported.full,
                reported.terminal,
              ],
            });
          }
          const before = (yield* engine.snapshot(owner)).projection;
          expect(before.runs[0]?.status).toBe(status);
          yield* say({
            type: "batch",
            sequence: ++sequence,
            items: [
              {
                kind: "preparation.failed",
                ...target,
                message: "A late checkout report must not replace the run's outcome.",
              },
            ],
          });
          const after = (yield* engine.snapshot(owner)).projection;
          expect(after.runs).toEqual(before.runs);
          expect(after.turnItems).toEqual(before.turnItems);
        }),
      ),
  );
});
