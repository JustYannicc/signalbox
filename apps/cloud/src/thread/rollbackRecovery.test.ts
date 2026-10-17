import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { firstCommit, finish, fixture, undo } from "./rollbackTesting.ts";
import { connect, freshDatabase, launch, owner, send, withObject } from "./runnerTesting.ts";
import * as ThreadStore from "./ThreadStore.ts";

describe("cloud rollback recovery", () => {
  it.effect.each(["files-restored", "conversation-updated"] as const)(
    "resumes %s without repeating the drive move",
    (stage) => {
      const f = fixture();
      const filename = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(
          filename,
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* launch(engine);
              const machine = yield* connect(runner);
              const first = yield* finish(
                runner,
                machine.generation,
                1,
                f,
                firstCommit,
                null,
                "answer",
              );
              const sql = Context.get(context, SqlClient.SqlClient);
              if (stage === "files-restored") {
                yield* sql`CREATE TRIGGER crash BEFORE INSERT ON events
              WHEN json_extract(NEW.event, '$.payload.status') = 'rolled_back'
              BEGIN SELECT RAISE(ABORT, 'simulated process loss'); END`;
              } else {
                yield* sql`CREATE TRIGGER crash BEFORE INSERT ON receipts
              WHEN NEW.command_type = 'checkpoint.rollback'
              BEGIN SELECT RAISE(ABORT, 'simulated process loss'); END`;
              }
              expect(
                (yield* Effect.exit(undo(engine, first.turn.runId, "stage-crash", true)))._tag,
              ).toBe("Failure");
              const pending = yield* Context.get(context, ThreadStore.ThreadStore).pendingRollback;
              expect(pending).toMatchObject({ stage, version: 1 });
              yield* sql`DROP TRIGGER crash`;
            }),
          f.options,
        );
        yield* withObject(
          filename,
          (engine, _runner, context) =>
            Effect.gen(function* () {
              yield* engine.step;
              const store = Context.get(context, ThreadStore.ThreadStore);
              expect(yield* store.pendingRollback).toBeNull();
              expect((yield* store.receipt(CommandId.make("stage-crash")))?._tag).toBe("accepted");
              expect(f.calls).toHaveLength(1);
              expect((yield* engine.snapshot(owner)).projection.runs[0]?.status).toBe(
                "rolled_back",
              );
            }),
          f.options,
        );
      });
    },
  );

  it.effect("waits for an asynchronously stopping machine before restoring", () => {
    const f = fixture();
    return withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const first = yield* finish(
            runner,
            machine.generation,
            1,
            f,
            firstCommit,
            null,
            "answer",
          );
          f.state.stopping = true;
          expect(
            (yield* Effect.exit(undo(engine, first.turn.runId, "stop-machine", true)))._tag,
          ).toBe("Failure");
          expect(f.calls).toHaveLength(0);
          expect((yield* Effect.exit(engine.step))._tag).toBe("Failure");
          expect(f.calls).toHaveLength(0);
          f.state.stopping = false;
          yield* engine.step;
          expect(f.order).toEqual(["stop", "stop", "stop", "restore"]);
        }),
      f.options,
    );
  });

  it.effect(
    "recovers a lost restore response after eviction and blocks new work until recovery",
    () => {
      const f = fixture();
      const filename = freshDatabase();
      return Effect.gen(function* () {
        const firstRun = yield* withObject(
          filename,
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* launch(engine);
              const machine = yield* connect(runner);
              const first = yield* finish(
                runner,
                machine.generation,
                1,
                f,
                firstCommit,
                null,
                "answer",
              );
              f.state.lostResponse = true;
              expect(
                (yield* Effect.exit(undo(engine, first.turn.runId, "recover", true)))._tag,
              ).toBe("Failure");
              expect(
                (yield* Context.get(context, ThreadStore.ThreadStore).pendingRollback)?.stage,
              ).toBe("prepared");
              expect(yield* engine.hasTurnWork).toBe(true);
              expect((yield* Effect.flip(send(engine, 2, "blocked"))).message).toContain(
                "recovery",
              );
              expect((yield* engine.snapshot(owner)).projection.runs[0]?.status).toBe("completed");
              return first.turn.runId;
            }),
          f.options,
        );
        yield* withObject(
          filename,
          (engine, _runner, context) =>
            Effect.gen(function* () {
              yield* engine.step;
              const store = Context.get(context, ThreadStore.ThreadStore);
              expect(yield* store.pendingRollback).toBeNull();
              const receipt = yield* store.receipt(CommandId.make("recover"));
              expect(receipt?._tag).toBe("accepted");
              expect(yield* undo(engine, firstRun, "recover", true)).toEqual({
                sequence: receipt?._tag === "accepted" ? receipt.sequence : -1,
              });
              expect(f.calls).toHaveLength(1);
              expect(f.restored.size).toBe(1);
              expect((yield* engine.snapshot(owner)).projection.runs[0]?.status).toBe(
                "rolled_back",
              );
            }),
          f.options,
        );
      });
    },
  );

  it.effect.each(["conflict", "refusal"] as const)(
    "persists %s, keeps conversation intact, and releases the pending write block",
    (failure) => {
      const f = fixture();
      const filename = freshDatabase();
      return Effect.gen(function* () {
        const firstRun = yield* withObject(
          filename,
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* launch(engine);
              const machine = yield* connect(runner);
              const first = yield* finish(
                runner,
                machine.generation,
                1,
                f,
                firstCommit,
                null,
                "answer",
              );
              f.state[failure] = true;
              const rejected = yield* Effect.flip(undo(engine, first.turn.runId));
              expect(rejected._tag).toBe("ThreadCommandRejectedError");
              const store = Context.get(context, ThreadStore.ThreadStore);
              expect(yield* store.pendingRollback).toBeNull();
              expect((yield* engine.snapshot(owner)).projection.runs[0]?.status).toBe("completed");
              expect(
                (yield* engine.snapshot(owner)).projection.thread.rollbackFailure?.message,
              ).toBe(rejected.message);
              const sql = Context.get(context, SqlClient.SqlClient);
              expect(yield* sql`SELECT stage FROM thread_rollbacks`).toEqual([{ stage: "failed" }]);
              return first.turn.runId;
            }),
          f.options,
        );
        yield* withObject(
          filename,
          (engine) =>
            Effect.gen(function* () {
              expect((yield* Effect.flip(undo(engine, firstRun)))._tag).toBe(
                "ThreadCommandRejectedError",
              );
              expect(f.calls).toHaveLength(1);
              yield* send(engine, 2, "unblocked");
            }),
          f.options,
        );
      });
    },
  );
});
