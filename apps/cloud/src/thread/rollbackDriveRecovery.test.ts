import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { realDrive } from "./rollbackDriveTesting.ts";
import { undo } from "./rollbackTesting.ts";
import {
  connect,
  freshDatabase,
  launch,
  owner,
  send,
  threadId,
  withObject,
} from "./runnerTesting.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { wipRef } from "../drive/DriveStore.ts";

describe("rollback recovery with enforcing Drive storage", () => {
  it.effect("completes a committed restore after losing the response and revoking access", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drive = yield* realDrive;
        const filename = freshDatabase();
        const firstRun = yield* withObject(
          filename,
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* launch(engine, "launch-1", drive.creation);
              const machine = yield* connect(runner);
              const first = yield* drive.finish(runner, machine.generation, 1, drive.first, null);
              yield* send(engine, 2, "Second");
              yield* drive.finish(runner, machine.generation, 2, drive.second, drive.first);
              drive.state.loseResponse = true;
              expect((yield* Effect.exit(undo(engine, first.runId, "lost-revoked")))._tag).toBe(
                "Failure",
              );
              expect((yield* drive.handle.refs(threadId)).thread).toBe(drive.first);
              expect(
                (yield* Context.get(context, ThreadStore.ThreadStore).pendingRollback)?.stage,
              ).toBe("prepared");
              expect(
                (yield* engine.snapshot(owner)).projection.runs.map((run) => run.status),
              ).toEqual(["completed", "completed"]);
              return first.runId;
            }),
          drive.options,
        );

        const request = drive.calls[0]!;
        // The revoked public caller still gets no refs, even when this exact operation committed.
        expect(
          yield* Effect.promise(() => drive.base.restoreCheckpoint(owner.userId, request)),
        ).toEqual({
          _tag: "refused",
          reason: "You no longer have access to change this drive.",
        });
        expect(yield* drive.handle.restoreCheckpointStatus(owner.userId, request)).toBe(
          "committed",
        );
        expect(yield* drive.handle.restoreCheckpointStatus("someone-else", request)).toBe(
          "not-committed",
        );
        expect(
          yield* drive.handle.restoreCheckpointStatus(owner.userId, {
            ...request,
            boundary: "start",
          }),
        ).toBe("not-committed");
        expect(
          yield* drive.handle.restoreCheckpointStatus(owner.userId, {
            ...request,
            generation: request.generation + 1,
          }),
        ).toBe("not-committed");
        yield* withObject(
          filename,
          (engine, _runner, context) =>
            Effect.gen(function* () {
              yield* engine.step;
              const store = Context.get(context, ThreadStore.ThreadStore);
              expect(yield* store.pendingRollback).toBeNull();
              expect((yield* store.receipt(CommandId.make("lost-revoked")))?._tag).toBe("accepted");
              const projection = (yield* engine.snapshot(owner)).projection;
              expect(projection.runs.map((run) => run.status)).toEqual([
                "completed",
                "rolled_back",
              ]);
              expect(projection.thread.rollbackFailure).toBeNull();
              expect(drive.calls).toHaveLength(1);
              expect(yield* undo(engine, firstRun, "lost-revoked")).toMatchObject({
                sequence: expect.any(Number),
              });
              expect((yield* drive.handle.refs(threadId)).thread).toBe(drive.first);
            }),
          drive.options,
        );
      }),
    ),
  );

  it.effect(
    "checks a refused response against a restore committed after its first status lookup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const drive = yield* realDrive;
          yield* withObject(
            freshDatabase(),
            (engine, runner, context) =>
              Effect.gen(function* () {
                yield* launch(engine, "launch-1", drive.creation);
                const machine = yield* connect(runner);
                const first = yield* drive.finish(runner, machine.generation, 1, drive.first, null);
                yield* send(engine, 2, "Second");
                yield* drive.finish(runner, machine.generation, 2, drive.second, drive.first);
                drive.state.returnRefusalAfterCommit = true;
                yield* undo(engine, first.runId, "late-commit");
                expect(
                  (yield* Context.get(context, ThreadStore.ThreadStore).receipt(
                    CommandId.make("late-commit"),
                  ))?._tag,
                ).toBe("accepted");
                expect(
                  (yield* engine.snapshot(owner)).projection.runs.map((run) => run.status),
                ).toEqual(["completed", "rolled_back"]);
                expect((yield* drive.handle.refs(threadId)).thread).toBe(drive.first);
              }),
            drive.options,
          );
        }),
      ),
  );

  it.effect(
    "leaves an unverified legacy commit pending until authorized replay can confirm it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const drive = yield* realDrive;
          const filename = freshDatabase();
          yield* withObject(
            filename,
            (engine, runner) =>
              Effect.gen(function* () {
                yield* launch(engine, "launch-1", drive.creation);
                const machine = yield* connect(runner);
                const first = yield* drive.finish(runner, machine.generation, 1, drive.first, null);
                yield* send(engine, 2, "Second");
                yield* drive.finish(runner, machine.generation, 2, drive.second, drive.first);
                drive.state.loseResponse = true;
                expect((yield* Effect.exit(undo(engine, first.runId, "legacy-commit")))._tag).toBe(
                  "Failure",
                );
              }),
            drive.options,
          );
          yield* drive.run(drive.sql`UPDATE drive_revision_operations SET requester_id = NULL`);
          yield* withObject(
            filename,
            (engine, _runner, context) =>
              Effect.gen(function* () {
                expect((yield* Effect.exit(engine.step))._tag).toBe("Failure");
                const store = Context.get(context, ThreadStore.ThreadStore);
                expect((yield* store.pendingRollback)?.stage).toBe("prepared");
                expect(yield* store.receipt(CommandId.make("legacy-commit"))).toBeNull();
                expect(
                  (yield* engine.snapshot(owner)).projection.runs.map((run) => run.status),
                ).toEqual(["completed", "completed"]);
                expect((yield* drive.handle.refs(threadId)).thread).toBe(drive.first);
                expect((yield* drive.restoreAccess())._tag).toBe("ok");
                yield* engine.step;
                expect(yield* store.pendingRollback).toBeNull();
                expect((yield* store.receipt(CommandId.make("legacy-commit")))?._tag).toBe(
                  "accepted",
                );
                expect(
                  (yield* engine.snapshot(owner)).projection.runs.map((run) => run.status),
                ).toEqual(["completed", "rolled_back"]);
              }),
            drive.options,
          );
        }),
      ),
  );

  it.effect("can restore files after conversation-only undo without starting another machine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drive = yield* realDrive;
        yield* withObject(
          freshDatabase(),
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* launch(engine, "launch-1", drive.creation);
              const machine = yield* connect(runner);
              const first = yield* drive.finish(runner, machine.generation, 1, drive.first, null);
              yield* send(engine, 2, "Second");
              yield* drive.finish(runner, machine.generation, 2, drive.second, drive.first);
              const before = yield* drive.handle.refs(threadId);
              yield* undo(engine, first.runId, "conversation-only", false, false);
              expect(yield* drive.handle.refs(threadId)).toEqual(before);
              expect(
                (yield* drive.handle.updateRefs(drive.writer(machine.generation), [
                  { name: wipRef(threadId), old: before.wip, new: drive.concurrent },
                ]))._tag,
              ).toBe("refused");
              yield* undo(engine, first.runId, "files-after-conversation");
              expect((yield* drive.handle.refs(threadId)).thread).toBe(drive.first);
              const store = Context.get(context, ThreadStore.ThreadStore);
              expect(yield* store.pendingRollback).toBeNull();
              const lease = yield* store.machine;
              expect(
                yield* drive.run(
                  drive.sql`SELECT generation FROM threads WHERE thread_id = ${threadId}`,
                ),
              ).toEqual([{ generation: lease.generation }]);
              expect(
                (yield* engine.snapshot(owner)).projection.runs.map((run) => run.status),
              ).toEqual(["completed", "rolled_back"]);
            }),
          drive.options,
        );
      }),
    ),
  );

  it.effect.each(["revokeBeforeRestore", "conflictBeforeRestore"] as const)(
    "can restore after a terminal %s failure without starting another machine",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const drive = yield* realDrive;
          yield* withObject(
            freshDatabase(),
            (engine, runner, context) =>
              Effect.gen(function* () {
                yield* launch(engine, "launch-1", drive.creation);
                const machine = yield* connect(runner);
                const first = yield* drive.finish(runner, machine.generation, 1, drive.first, null);
                yield* send(engine, 2, "Second");
                yield* drive.finish(runner, machine.generation, 2, drive.second, drive.first);
                drive.state[failure] = true;
                expect((yield* Effect.flip(undo(engine, first.runId, "failed-undo")))._tag).toBe(
                  "ThreadCommandRejectedError",
                );
                expect((yield* drive.handle.refs(threadId)).thread).toBe(drive.second);
                const store = Context.get(context, ThreadStore.ThreadStore);
                expect(yield* store.pendingRollback).toBeNull();
                const retired = (yield* store.machine).generation;
                expect(
                  yield* drive.run(
                    drive.sql`SELECT generation FROM threads WHERE thread_id = ${threadId}`,
                  ),
                ).toEqual([{ generation: retired }]);
                yield* drive.restoreAccess();
                yield* undo(engine, first.runId, "retry-new-command");
                expect((yield* drive.handle.refs(threadId)).thread).toBe(drive.first);
                expect((yield* store.receipt(CommandId.make("retry-new-command")))?._tag).toBe(
                  "accepted",
                );
                expect(
                  (yield* engine.snapshot(owner)).projection.runs.map((run) => run.status),
                ).toEqual(["completed", "rolled_back"]);
              }),
            drive.options,
          );
        }),
      ),
  );
});
