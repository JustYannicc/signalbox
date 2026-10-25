import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { loadingPreparation } from "./preparationTesting.ts";
import {
  freshDatabase,
  owner,
  personal,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

describe("preparation retry with an edited queue", () => {
  it.effect(
    "keeps reordered messages held until the retried preparation finishes and the queue resumes",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, generation, turn, say, pushWork } = yield* loadingPreparation(
            engine,
            runner,
          );
          yield* send(engine, 2, "First queued");
          yield* send(engine, 3, "Second queued");
          yield* say({
            type: "batch",
            sequence: 1,
            items: [{ kind: "preparation.failed", ...target }],
          });
          const held = (yield* snapshot(engine)).projection.runs.filter(
            (run) => run.status === "queued",
          );
          expect(held).toHaveLength(2);
          expect(held.every((run) => run.queueHeld === true)).toBe(true);
          const [first, second] = held;
          yield* engine.dispatch(
            owner,
            {
              type: "queued-run.edit",
              commandId: CommandId.make("edit-after-preparation-failure"),
              threadId,
              runId: second!.id,
              text: "Edited second",
            },
            personal,
          );
          yield* engine.dispatch(
            owner,
            {
              type: "queued-run.reorder",
              commandId: CommandId.make("reorder-after-preparation-failure"),
              threadId,
              runId: second!.id,
              beforeRunId: first!.id,
            },
            personal,
          );
          yield* engine.dispatch(
            owner,
            {
              type: "prepared-run.retry",
              commandId: CommandId.make("retry-before-held-queue"),
              ...target,
            },
            personal,
          );
          yield* Effect.promise(pushWork);
          const retried = (yield* runner.work).turn!;
          expect(retried).toMatchObject({
            runId: turn.runId,
            preparationGeneration: target.preparationGeneration + 1,
            message: { text: "Hi" },
          });
          yield* say({
            type: "batch",
            sequence: 2,
            items: [
              {
                kind: "preparation.ready",
                runId: retried.runId,
                preparationGeneration: retried.preparationGeneration,
              },
            ],
          });
          const report = turnReport(retried.runId, retried.runOrdinal, retried.providerThread);
          yield* say({
            type: "batch",
            sequence: 3,
            items: [
              { ...report.started, preparationGeneration: retried.preparationGeneration },
              report.full,
              report.terminal,
            ],
          });
          expect((yield* runner.work).turn).toBeNull();
          expect(
            (yield* snapshot(engine)).projection.runs.filter((run) => run.status === "queued"),
          ).toEqual(
            expect.arrayContaining(
              held.map((run) => expect.objectContaining({ id: run.id, queueHeld: true })),
            ),
          );
          yield* engine.dispatch(
            owner,
            {
              type: "queue.resume",
              commandId: CommandId.make("resume-edited-queue"),
              threadId,
            },
            personal,
          );
          const next = (yield* runner.work).turn;
          expect(next?.runId).toBe(second!.id);
          expect(next?.message.text.endsWith("User message:\nEdited second")).toBe(true);
          expect((yield* engine.preparation)?.machineGeneration).toBe(generation);
          expect((yield* engine.preparation)?.generation).toBe(target.preparationGeneration + 2);
        }),
      ),
  );
});
