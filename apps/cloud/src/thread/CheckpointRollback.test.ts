import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  firstCommit,
  secondCommit,
  thirdCommit,
  command,
  finish,
  fixture,
  undo,
} from "./rollbackTesting.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  send,
  threadId,
  withObject,
} from "./runnerTesting.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { applyEvents } from "./threadProjection.ts";
import { threadEvent } from "./threadEvents.ts";

describe("cloud checkpoint rollback", () => {
  it.effect(
    "restores files and the same conversation boundary, replays its receipt, and starts a trimmed fresh session",
    () => {
      const f = fixture();
      return withObject(
        freshDatabase(),
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
              "keep first answer",
            );
            yield* send(engine, 2, "remove second request");
            const second = yield* finish(
              runner,
              machine.generation,
              2,
              f,
              secondCommit,
              firstCommit,
              "remove second answer",
            );
            const before = yield* engine.snapshot(owner);
            const sql = Context.get(context, SqlClient.SqlClient);
            yield* sql`CREATE TABLE transitions (stage TEXT)`;
            yield* sql`CREATE TRIGGER journal_insert AFTER INSERT ON thread_rollbacks BEGIN INSERT INTO transitions VALUES (NEW.stage); END`;
            yield* sql`CREATE TRIGGER journal_update AFTER UPDATE ON thread_rollbacks BEGIN INSERT INTO transitions VALUES (NEW.stage); END`;

            const result = yield* undo(engine, first.turn.runId);
            expect(yield* undo(engine, first.turn.runId)).toEqual(result);
            const store = Context.get(context, ThreadStore.ThreadStore);
            expect(yield* store.receipt(CommandId.make("undo"))).toEqual({
              _tag: "accepted",
              sequence: result.sequence,
            });
            expect(yield* sql`SELECT stage FROM transitions`).toEqual([
              { stage: "prepared" },
              { stage: "files-restored" },
              { stage: "conversation-updated" },
              { stage: "completed" },
            ]);
            expect(f.order).toEqual(["stop", "restore"]);
            expect(f.calls).toMatchObject([
              { runId: first.turn.runId, boundary: "end", generation: machine.generation },
            ]);
            expect(f.refs().thread).toBe(firstCommit);
            const after = yield* engine.snapshot(owner);
            expect(after.projection.runs.map((run) => run.status)).toEqual([
              "completed",
              "rolled_back",
            ]);
            expect(after.projection.providerThreads[0]?.nativeThreadRef).toBeNull();
            expect(after.projection.providerSessions).toEqual(before.projection.providerSessions);
            expect(after.projection.visibleTurnItems.map(({ item }) => item.runId)).not.toContain(
              second.turn.runId,
            );
            expect(
              after.projection.checkpoints.find((item) => item.runId === second.turn.runId)?.status,
            ).toBe("stale");

            const stream = yield* engine.subscribe(owner, {
              threadId,
              afterSequence: before.snapshotSequence,
              requestCompletionMarker: true,
            });
            const replay = yield* stream.pipe(
              Stream.flattenIterable,
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            );
            expect(
              applyEvents(
                before.projection,
                replay.flatMap((item) => (item.kind === "event" ? [item.event] : [])),
              ),
            ).toEqual(after.projection);
            expect(
              yield* runner.batch({
                generation: machine.generation,
                sequence: 3,
                items: [second.report.full],
              }),
            ).toMatchObject({ _tag: "stale" });
            yield* send(engine, 3, "next request");
            const next = yield* connect(runner);
            expect(next.generation).toBeGreaterThan(machine.generation);
            const turn = yield* liveTurn(runner);
            expect(turn.providerThread.nativeThreadRef).toBeNull();
            expect(turn.providerTurnOrdinal).toBe(1);
            expect(turn.message.text).toContain("keep first answer");
            expect(turn.message.text).not.toContain("remove second");
          }),
        f.options,
      );
    },
  );

  it.effect.each([null, thirdCommit])(
    "restores a reusable first-turn baseline with start %s",
    (start) => {
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
              start,
              "first answer",
            );
            yield* undo(engine, first.turn.runId, "baseline-1", true);
            expect(f.calls[0]?.boundary).toBe("start");
            expect(f.refs().thread).toBe(start);
            expect((yield* engine.snapshot(owner)).projection.visibleTurnItems).toHaveLength(0);
            yield* send(engine, 2, "new branch");
            const next = yield* connect(runner);
            yield* finish(runner, next.generation, 1, f, secondCommit, start, "new answer");
            yield* undo(engine, first.turn.runId, "baseline-2", true);
            const projection = (yield* engine.snapshot(owner)).projection;
            expect(projection.runs.map((run) => run.status)).toEqual([
              "rolled_back",
              "rolled_back",
            ]);
            expect(
              projection.checkpoints.find((item) => item.ordinalWithinScope === 0)?.status,
            ).toBe("ready");
            expect(f.calls.map((call) => call.boundary)).toEqual(["start", "start"]);
          }),
        f.options,
      );
    },
  );

  it.effect("supports conversation-only undo without moving files", () => {
    const f = fixture();
    return withObject(
      freshDatabase(),
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
            "first answer",
          );
          const refs = f.refs();
          yield* undo(engine, first.turn.runId, "conversation", true, false);
          expect(f.refs()).toEqual(refs);
          expect(f.calls).toHaveLength(0);
          expect(f.order).toEqual(["stop"]);
          expect((yield* Context.get(context, ThreadStore.ThreadStore).machine).generation).toBe(
            machine.generation + 1,
          );
          expect(
            (yield* engine.snapshot(owner)).projection.providerThreads[0]?.nativeThreadRef,
          ).toBeNull();
        }),
      f.options,
    );
  });

  it.effect("backfills the first checkpoint for older threads exactly once on rehydration", () => {
    const f = fixture();
    const filename = freshDatabase();
    return Effect.gen(function* () {
      const runId = yield* withObject(
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
            yield* sql`DELETE FROM events WHERE json_extract(event, '$.type') = 'checkpoint.captured'
          AND json_extract(event, '$.payload.ordinalWithinScope') = 0`;
            return first.turn.runId;
          }),
        f.options,
      );
      const head = yield* withObject(
        filename,
        (engine) =>
          Effect.gen(function* () {
            const snapshot = yield* engine.snapshot(owner);
            expect(
              snapshot.projection.checkpoints.filter((item) => item.ordinalWithinScope === 0),
            ).toMatchObject([{ id: `checkpoint:${runId}:start`, ref: "empty", status: "ready" }]);
            return snapshot.snapshotSequence;
          }),
        f.options,
      );
      yield* withObject(
        filename,
        (engine) =>
          Effect.gen(function* () {
            expect((yield* engine.snapshot(owner)).snapshotSequence).toBe(head);
            yield* undo(engine, runId, "backfilled", true);
            expect(f.calls[0]?.boundary).toBe("start");
          }),
        f.options,
      );
    });
  });

  it.effect(
    "rejects active, queued, mismatched, inaccessible, and deleted targets without external effects",
    () => {
      const f = fixture();
      return withObject(
        freshDatabase(),
        (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            expect((yield* Effect.flip(undo(engine, turn.runId, "active"))).message).toContain(
              "active",
            );
            const first = yield* finish(
              runner,
              machine.generation,
              1,
              f,
              firstCommit,
              null,
              "answer",
            );
            expect(
              (yield* Effect.flip(
                engine.dispatch(
                  { ...owner, userId: "stranger" },
                  command(first.turn.runId),
                  personal,
                ),
              ))._tag,
            ).toBe("ThreadNotFoundError");
            const badScope = {
              ...command(first.turn.runId, "scope"),
              scopeId: command("different").scopeId,
            };
            expect(
              (yield* Effect.flip(engine.dispatch(owner, badScope, personal))).message,
            ).toContain("available");
            f.state.role = null;
            expect(
              (yield* Effect.flip(undo(engine, first.turn.runId, "access"))).message,
            ).toContain("drive");
            f.state.role = "contributor";
            yield* send(engine, 2, "active again");
            yield* send(engine, 3, "queued");
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("stop"),
                threadId,
                runId: (yield* liveTurn(runner)).runId,
                holdQueue: true,
              },
              personal,
            );
            expect(
              (yield* Effect.flip(undo(engine, first.turn.runId, "queued"))).message,
            ).toContain("queue");
            yield* engine.apply((projection, ctx) =>
              Effect.succeed({
                events:
                  projection === null
                    ? []
                    : [
                        threadEvent(ctx, "thread.metadata-updated", {
                          ...projection.thread,
                          deletedAt: ctx.now,
                        }),
                      ],
                result: undefined,
              }),
            );
            expect(
              (yield* Effect.flip(undo(engine, first.turn.runId, "deleted"))).message,
            ).toContain("deleted");
            expect(f.calls).toHaveLength(0);
          }),
        f.options,
      );
    },
  );
});
