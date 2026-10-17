import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerItem,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { CommandId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  freshDatabase,
  hello,
  launch,
  owner,
  personal,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";
import type * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import type * as ThreadRunner from "./runner/ThreadRunner.ts";

const preparing = (
  engine: ThreadEngine.ThreadEngine["Service"],
  runner: ThreadRunner.ThreadRunner["Service"],
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("No machine requested");
    yield* runner.hello({
      ...hello(plan.ensure.generation, plan.ensure.token),
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    });
    const work = yield* runner.work;
    const turn = work.turn;
    if (turn?.preparationGeneration === undefined) throw new Error("No addressed preparation");
    return {
      turn,
      generation: plan.ensure.generation,
      work,
      target: { threadId, runId: turn.runId, preparationGeneration: turn.preparationGeneration },
    };
  });

const snapshot = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.flatMap(engine.subscribePreparation(owner), Stream.runHead).pipe(
    Effect.map((head): WorktreeSetupSnapshot => {
      if (Option.isNone(head) || head.value === null) throw new Error("No preparation snapshot");
      return head.value;
    }),
  );

describe("durable thread preparation", () => {
  it.effect(
    "cancels only the addressed checkout, fences late reports, and retries the same run on its machine",
    () =>
      withObject(
        freshDatabase(),
        (engine, runner, context) =>
          Effect.gen(function* () {
            const { turn, generation, target, work } = yield* preparing(engine, runner);
            let sequence = 0;
            const batch = (...items: ReadonlyArray<RunnerItem>) =>
              runner.batch({ generation, sequence: ++sequence, items });
            yield* batch({
              kind: "preparation.progress",
              ...target,
              stage: "checkout",
              status: "running",
            });
            expect(
              yield* engine.cancelPreparation(owner, { threadId }).pipe(Effect.flip),
            ).toMatchObject({ _tag: "WorktreeSetupError" });
            expect(
              yield* engine
                .cancelPreparation(owner, { ...target, preparationGeneration: 99 })
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: "WorktreeSetupError" });
            yield* engine.cancelPreparation(owner, target);
            const cancelling = yield* snapshot(engine);
            expect(cancelling).toMatchObject({
              phase: "running",
              cancellationRequested: true,
              turnStarted: false,
            });
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* batch(
              { kind: "preparation.progress", ...target, stage: "checkout", status: "done" },
              { kind: "preparation.ready", ...target },
              { ...report.started, preparationGeneration: target.preparationGeneration },
              {
                kind: "dependencies.progress",
                ...target,
                root: "",
                status: "installed",
                message: "late",
              },
            );
            expect(yield* snapshot(engine)).toEqual(cancelling);
            expect((yield* engine.snapshot(owner)).projection.runs[0]?.status).toBe("starting");
            yield* batch({ kind: "preparation.cancelled", ...target });
            expect(yield* snapshot(engine)).toMatchObject({
              phase: "cancelled",
              cancellationRequested: false,
              turnStarted: false,
            });
            const storedMachine = yield* ThreadStore.ThreadStore.use((store) =>
              Effect.orDie(store.machine),
            ).pipe(Effect.provideContext(context));
            expect(storedMachine).toMatchObject({ generation, status: "connected" });
            expect((yield* runner.reconcile).release).toBeNull();

            yield* engine.dispatch(
              owner,
              { type: "prepared-run.retry", commandId: CommandId.make("retry"), ...target },
              personal,
            );
            const retried = yield* runner.work;
            expect(retried.turn?.runId).toBe(turn.runId);
            expect(retried.turn?.message).toEqual(turn.message);
            expect(retried.turn?.preparationGeneration).toBe(target.preparationGeneration + 1);
            expect(retried.drive).toEqual(work.drive);
            expect(retried.generation).toBe(generation);
            expect(
              (yield* engine.snapshot(owner)).projection.messages.filter(
                (message) => message.role === "user",
              ),
            ).toHaveLength(1);
            const current = { ...target, preparationGeneration: target.preparationGeneration + 1 };
            const before = yield* snapshot(engine);
            expect(before.sequence).toBeGreaterThan(cancelling.sequence);
            yield* batch(
              { kind: "preparation.ready", ...target },
              { kind: "preparation.cancelled", ...target },
              {
                kind: "dependencies.progress",
                ...target,
                root: "",
                status: "installed",
                message: "old attempt",
              },
            );
            expect(yield* snapshot(engine)).toEqual(before);
            expect(yield* engine.cancelPreparation(owner, target).pipe(Effect.flip)).toMatchObject({
              _tag: "WorktreeSetupError",
            });
            expect(
              yield* engine
                .dispatch(
                  owner,
                  {
                    type: "prepared-run.retry",
                    commandId: CommandId.make("stale-retry"),
                    ...target,
                  },
                  personal,
                )
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: "ThreadCommandRejectedError" });
            yield* batch({ kind: "preparation.ready", ...current });
            expect(yield* snapshot(engine)).toMatchObject({ phase: "running", turnStarted: true });
            expect(yield* engine.cancelPreparation(owner, current).pipe(Effect.flip)).toMatchObject(
              { _tag: "WorktreeSetupError" },
            );
            yield* batch({
              ...report.started,
              preparationGeneration: target.preparationGeneration,
            });
            expect((yield* engine.snapshot(owner)).projection.runs[0]?.status).toBe("starting");
            const startedBatch = {
              generation,
              sequence: ++sequence,
              items: [{ ...report.started, preparationGeneration: current.preparationGeneration }],
            };
            yield* runner.batch(startedBatch);
            const started = yield* engine.snapshot(owner);
            yield* runner.batch(startedBatch);
            expect((yield* engine.snapshot(owner)).snapshotSequence).toBe(started.snapshotSequence);
            expect(started.projection.runs[0]?.status).toBe("running");
            expect(yield* snapshot(engine)).toMatchObject({ phase: "done", turnStarted: true });
          }),
        { drives: true },
      ),
  );

  it.effect(
    "publishes initial persisted state and ordered changes, retaining failed attempts across eviction until retry",
    () =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        const terminal = yield* withObject(filename, (engine, runner) =>
          Effect.gen(function* () {
            const { target, generation } = yield* preparing(engine, runner);
            const stream = yield* engine.subscribePreparation(owner);
            const collected = yield* stream.pipe(
              Stream.takeUntil((value) => value?.phase === "failed"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* runner.batch({
              generation,
              sequence: 1,
              items: [
                { kind: "preparation.progress", ...target, stage: "checkout", status: "running" },
              ],
            });
            yield* runner.batch({
              generation,
              sequence: 2,
              items: [{ kind: "preparation.failed", ...target }],
            });
            const updates = yield* Fiber.join(collected);
            expect(updates.map((value) => value?.sequence)).toEqual(
              updates
                .map((value) => value?.sequence)
                .sort((left, right) => (left ?? 0) - (right ?? 0)),
            );
            expect(updates).toHaveLength(3);
            const failed = yield* snapshot(engine);
            expect(failed.worktreePath).toBeNull();
            expect(failed.setupScript).toBeNull();
            expect(failed.error).toBe("Preparing this thread failed. You can try again.");
            return { failed, target };
          }),
        );
        yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            expect(yield* snapshot(engine)).toEqual(terminal.failed);
            expect(
              yield* engine
                .dispatch(
                  owner,
                  {
                    type: "prepared-run.retry",
                    commandId: CommandId.make("missing-guard"),
                    threadId,
                    runId: terminal.target.runId,
                  },
                  personal,
                )
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: "ThreadCommandRejectedError" });
            yield* engine.dispatch(
              owner,
              {
                type: "prepared-run.retry",
                commandId: CommandId.make("retry-after-eviction"),
                ...terminal.target,
              },
              personal,
            );
            expect(yield* snapshot(engine)).toMatchObject({
              phase: "running",
              preparationGeneration: terminal.target.preparationGeneration + 1,
            });
          }),
        );
      }),
  );

  it.effect(
    "settles cancellation after the lease is invalidated and refuses the old machine's progress",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, generation } = yield* preparing(engine, runner);
          yield* engine.cancelPreparation(owner, target);
          yield* runner.ended(generation, "gone");
          const cancelled = yield* snapshot(engine);
          expect(cancelled.phase).toBe("cancelled");
          expect((yield* engine.snapshot(owner)).projection.runs).toHaveLength(1);
          expect(
            yield* runner.batch({
              generation,
              sequence: 1,
              items: [{ kind: "preparation.ready", ...target }],
            }),
          ).toEqual({ _tag: "stale" });
          expect(yield* snapshot(engine)).toEqual(cancelled);
        }),
      ),
  );
  it.effect(
    "settles a cancellation racing checkout failure without waiting for another report",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, generation } = yield* preparing(engine, runner);
          yield* engine.cancelPreparation(owner, target);
          yield* runner.batch({
            generation,
            sequence: 1,
            items: [{ kind: "preparation.failed", ...target }],
          });
          expect(yield* snapshot(engine)).toMatchObject({
            phase: "cancelled",
            cancellationRequested: false,
            turnStarted: false,
          });
          yield* engine.dispatch(
            owner,
            {
              type: "prepared-run.retry",
              commandId: CommandId.make("retry-raced-cancellation"),
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
  it.effect("retains a retryable failure when a machine disappears during checkout", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { target, generation, turn } = yield* preparing(engine, runner);
        yield* runner.ended(generation, "gone");
        expect(yield* snapshot(engine)).toMatchObject({ phase: "failed", turnStarted: false });
        yield* engine.dispatch(
          owner,
          {
            type: "prepared-run.retry",
            commandId: CommandId.make("retry-lost-checkout"),
            ...target,
          },
          personal,
        );
        const plan = yield* runner.reconcile;
        if (plan.ensure === null) throw new Error("No replacement machine requested");
        yield* runner.hello({
          ...hello(plan.ensure.generation, plan.ensure.token),
          protocolVersion: RUNNER_PROTOCOL_VERSION,
        });
        const retried = yield* runner.work;
        expect(retried.turn?.runId).toBe(turn.runId);
        expect(retried.turn?.preparationGeneration).toBe(target.preparationGeneration + 1);
        const current = yield* snapshot(engine);
        expect(
          yield* runner.batch({
            generation,
            sequence: 1,
            items: [{ kind: "preparation.ready", ...target }],
          }),
        ).toEqual({ _tag: "stale" });
        expect(yield* snapshot(engine)).toEqual(current);
        yield* runner.batch({
          generation: plan.ensure.generation,
          sequence: 1,
          items: [
            {
              kind: "preparation.ready",
              ...target,
              preparationGeneration: target.preparationGeneration + 1,
            },
          ],
        });
        expect(yield* snapshot(engine)).toMatchObject({ phase: "running", turnStarted: true });
      }),
    ),
  );
});
