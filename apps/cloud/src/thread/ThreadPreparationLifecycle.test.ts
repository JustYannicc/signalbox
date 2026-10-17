import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  freshDatabase,
  owner,
  personal,
  send,
  turnReport,
  threadId,
  withObject,
} from "./runnerTesting.ts";
import { pushRunnerWork } from "./runner/runnerSockets.ts";
import { loadingPreparation } from "./preparationTesting.ts";

describe("preparation lifecycle stops", () => {
  it.effect(
    "a generic v7 run interrupt stops checkout and retains a retryable cancelled attempt",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, socket, host, say } = yield* loadingPreparation(engine, runner);
          yield* engine.dispatch(
            owner,
            {
              type: "run.interrupt",
              commandId: CommandId.make("generic-stop"),
              runId: target.runId,
              threadId,
              holdQueue: true,
            },
            personal,
          );
          expect((yield* engine.preparation)?.status).toBe("cancelling");
          yield* Effect.promise(() => pushRunnerWork(host));
          expect(socket.sent).toContainEqual({
            type: "preparation.cancel",
            runId: target.runId,
            preparationGeneration: target.preparationGeneration,
          });
          expect((yield* engine.preparation)?.snapshot.phase).toBe("running");
          yield* say({
            type: "batch",
            sequence: 1,
            items: [{ kind: "preparation.ready", ...target }],
          });
          expect(socket.sent.some((frame) => frame.type === "preparation.handoff")).toBe(false);
          yield* say({
            type: "batch",
            sequence: 2,
            items: [{ kind: "preparation.cancelled", ...target }],
          });
          expect((yield* engine.preparation)?.snapshot.phase).toBe("cancelled");
          yield* engine.dispatch(
            owner,
            {
              type: "prepared-run.retry",
              commandId: CommandId.make("retry-generic-stop"),
              ...target,
            },
            personal,
          );
          expect((yield* runner.work).turn?.preparationGeneration).toBe(
            target.preparationGeneration + 1,
          );
        }),
      ),
  );

  it.effect.each([true, false])(
    "keeps queue hold=%s while a previous checkout stops, without superseding its attempt",
    (holdQueue) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, socket, host, say } = yield* loadingPreparation(engine, runner);
          yield* send(engine, 2, "Next run");
          yield* engine.dispatch(
            owner,
            {
              type: "run.interrupt",
              commandId: CommandId.make("stop-with-queue"),
              threadId,
              runId: target.runId,
              holdQueue,
            },
            personal,
          );
          const before = yield* engine.preparation;
          expect(before).toMatchObject({ runId: target.runId, status: "cancelling" });
          expect((yield* runner.work).turn).toBeNull();
          expect((yield* engine.preparation)?.runId).toBe(target.runId);
          const queued = (yield* engine.snapshot(owner)).projection.runs[1];
          expect(queued?.status).toBe(holdQueue ? "queued" : "starting");
          if (holdQueue) expect(queued?.queueHeld).toBe(true);
          yield* Effect.promise(() => pushRunnerWork(host));
          expect(socket.sent.some((frame) => frame.type === "turn.start")).toBe(false);
          yield* say({
            type: "batch",
            sequence: 1,
            items: [{ kind: "preparation.cancelled", ...target }],
          });
          if (holdQueue) {
            expect((yield* runner.work).turn).toBeNull();
            yield* engine.dispatch(
              owner,
              { type: "queue.resume", commandId: CommandId.make("resume-after-stop"), threadId },
              personal,
            );
          }
          const next = yield* runner.work;
          expect(next.turn?.runId).toBe(queued?.id);
          expect(next.turn?.message.text).toContain("User message:\nNext run");
          expect(next.turn?.preparationGeneration).toBe(target.preparationGeneration + 1);
        }),
      ),
  );

  it.effect(
    "an interrupted checkout cannot hand off after another message restarts the queue",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, host, say, socket } = yield* loadingPreparation(engine, runner);
          yield* send(engine, 2, "Restart with this message");
          yield* engine.dispatch(
            owner,
            {
              type: "run.interrupt",
              commandId: CommandId.make("restart-active"),
              runId: target.runId,
              threadId,
            },
            personal,
          );
          yield* Effect.promise(() => pushRunnerWork(host));
          yield* say({
            type: "batch",
            sequence: 1,
            items: [
              { kind: "preparation.ready", ...target },
              { kind: "preparation.cancelled", ...target },
            ],
          });
          expect(
            socket.sent.some(
              (frame) => frame.type === "preparation.handoff" && frame.runId === target.runId,
            ),
          ).toBe(false);
          const next = socket.sent.find((frame) => frame.type === "turn.start");
          expect(next?.type === "turn.start" && next.turn.runId).not.toBe(target.runId);
          expect(next?.type === "turn.start" && next.turn.message.text).toContain(
            "User message:\nRestart with this message",
          );
        }),
      ),
  );

  it.effect.each(["interrupt", "machine loss", "failure"] as const)(
    "settles handoff before turn.started on %s, without promising preparation retry",
    (ending) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, turn, generation, say, host, socket } = yield* loadingPreparation(
            engine,
            runner,
          );
          yield* say({
            type: "batch",
            sequence: 1,
            items: [{ kind: "preparation.ready", ...target }],
          });
          expect((yield* engine.preparation)?.status).toBe("handoff");
          if (ending === "interrupt") {
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("handoff-stop"),
                runId: target.runId,
                threadId,
                holdQueue: true,
              },
              personal,
            );
            yield* Effect.promise(() => pushRunnerWork(host));
            expect(socket.sent).toContainEqual({
              type: "interrupt",
              runId: target.runId,
              preparationGeneration: target.preparationGeneration,
            });
          } else if (ending === "machine loss") {
            yield* runner.ended(generation, "gone");
          } else {
            yield* say({
              type: "batch",
              sequence: 2,
              items: [
                {
                  kind: "turn.failed",
                  ...target,
                  message: "The provider session could not be opened. Check that it is signed in.",
                },
              ],
            });
          }
          const ended = yield* engine.preparation;
          expect(ended?.snapshot.phase).not.toBe("running");
          expect(ended?.snapshot.turnStarted).toBe(true);
          expect(ended?.snapshot.error ?? "").not.toContain("try again");
          expect(ended?.snapshot.error ?? "").not.toContain("Preparing this thread failed");
          expect(
            yield* engine
              .dispatch(
                owner,
                {
                  type: "prepared-run.retry",
                  commandId: CommandId.make("unsafe-posthandoff-retry"),
                  ...target,
                },
                personal,
              )
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "ThreadCommandRejectedError" });
          if (ending === "interrupt") {
            const late = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* say({
              type: "batch",
              sequence: 2,
              items: [{ ...late.started, preparationGeneration: target.preparationGeneration }],
            });
            expect((yield* engine.snapshot(owner)).projection.runs[0]?.status).toBe("interrupted");
            expect((yield* engine.preparation)?.snapshot.phase).not.toBe("running");
          }
        }),
      ),
  );

  it.effect(
    "keeps the curated preparation failure in the thread while its setup snapshot stays fixed",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, say } = yield* loadingPreparation(engine, runner);
          const message =
            "This thread's instructions come to 80.0 KiB, over the 64.0 KiB agents can load. Shorten a folder's instructions or remove a shortcut.";
          yield* send(engine, 2, "Wait behind the failed checkout");
          yield* say({
            type: "batch",
            sequence: 1,
            items: [{ kind: "preparation.failed", ...target, message }],
          });
          const projection = (yield* engine.snapshot(owner)).projection;
          expect(projection.turnItems.find((item) => item.type === "error")).toMatchObject({
            failure: { message },
          });
          expect(projection.runs[1]).toMatchObject({ status: "queued", queueHeld: true });
          const snapshot = (yield* engine.preparation)?.snapshot;
          expect(snapshot?.phase).toBe("failed");
          expect(snapshot?.error).toBe(
            "Preparing this thread failed. Check the thread for details.",
          );
          expect(JSON.stringify(snapshot)).not.toContain("80.0 KiB");
        }),
      ),
  );
});
