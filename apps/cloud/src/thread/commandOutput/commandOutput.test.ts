import {
  CommandId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2CommandOutputFrame,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT } from "@t3tools/shared/terminalOutput";

import { ThreadStore } from "../ThreadStore.ts";
import {
  delta,
  firstFrame,
  freshDatabase,
  owner,
  personal,
  reportCommand,
  start,
  target,
  threadId,
  withObject,
} from "../commandOutputTestKit.ts";

const shown = (text: string) => appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, text).text;

describe("retained cloud command output", () => {
  it.effect("commits an output-only batch with its ack and replays it once after eviction", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const saved = yield* withObject(filename, (engine, runner, context) =>
        Effect.gen(function* () {
          const { batch, turn, machine } = yield* start(engine, runner);
          const store = Context.get(context, ThreadStore);
          const before = yield* store.events(0);
          const initial = yield* firstFrame(engine);
          yield* batch(2, [delta(turn.runId, "progress 10%\r\u001b[")]);
          const first = yield* firstFrame(engine);
          expect(first.sequence).toBeGreaterThan(initial.sequence!);
          expect(first.running).toBe(true);
          expect(yield* store.events(0)).toEqual(before);
          expect((yield* store.machine).ackedSequence).toBe(2);
          yield* batch(2, [delta(turn.runId, "progress 10%\r\u001b[")]);
          expect(yield* firstFrame(engine)).toEqual(first);
          return { first, runId: turn.runId, generation: machine.generation };
        }),
      );
      yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          expect(yield* firstFrame(engine)).toEqual(saved.first);
          yield* runner.batch({
            generation: saved.generation,
            sequence: 2,
            items: [delta(saved.runId, "DUPLICATE")],
          });
          expect(yield* firstFrame(engine)).toEqual(saved.first);
          yield* runner.batch({
            generation: saved.generation,
            sequence: 3,
            items: [delta(saved.runId, "2Kready")],
          });
          const resumed = yield* firstFrame(engine);
          expect(shown(resumed.text)).toBe("ready");
          expect(resumed.truncated).toBe(false);
        }),
      );
    }),
  );

  it.effect("checks owner, context, thread, command type and owning run before subscribing", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        expect(
          (yield* Effect.flip(engine.commandOutput({ ...owner, userId: "stranger" }, target)))._tag,
        ).toBe("ThreadNotFoundError");
        expect(
          (yield* Effect.flip(
            engine.commandOutput(owner, { ...target, threadId: ThreadId.make("wrong") }),
          ))._tag,
        ).toBe("OrchestrationV2CommandOutputError");
        const projection = (yield* engine.snapshot(owner)).projection;
        const userMessage = projection.turnItems.find((item) => item.type === "user_message")!;
        expect(
          (yield* Effect.flip(engine.commandOutput(owner, { ...target, itemId: userMessage.id })))
            ._tag,
        ).toBe("OrchestrationV2CommandOutputError");
        expect(
          (yield* Effect.flip(
            engine.commandOutput(owner, { ...target, itemId: TurnItemId.make("missing") }),
          ))._tag,
        ).toBe("OrchestrationV2CommandOutputError");
        const orphan = {
          ...command,
          id: TurnItemId.make("orphan"),
          runId: RunId.make("missing-run"),
        };
        yield* batch(2, [reportCommand(turn.runId, orphan)]);
        expect(
          (yield* Effect.flip(engine.commandOutput(owner, { ...target, itemId: orphan.id })))._tag,
        ).toBe("OrchestrationV2CommandOutputError");
      }),
    ),
  );

  it.effect("hides output when the owner no longer belongs to its organization", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      yield* withObject(filename, (engine, runner, context) =>
        Effect.gen(function* () {
          yield* start(engine, runner);
          const sql = Context.get(context, SqlClient.SqlClient);
          yield* sql`UPDATE owner SET context_id = 'org-1' WHERE id = 1`;
        }),
      );
      yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          expect((yield* Effect.flip(engine.commandOutput(owner, target)))._tag).toBe(
            "ThreadNotFoundError",
          );
        }),
      );
    }),
  );

  it.effect("drops wrong run/thread/item, stale generation and out-of-order deltas", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, machine } = yield* start(engine, runner);
        const before = yield* firstFrame(engine);
        expect(
          yield* runner.batch({
            generation: machine.generation - 1,
            sequence: 2,
            items: [delta(turn.runId, "stale")],
          }),
        ).toEqual({ _tag: "stale" });
        expect(yield* batch(3, [delta(turn.runId, "gap")])).toEqual({
          _tag: "out_of_order",
          ackedSequence: 1,
        });
        yield* batch(2, [
          delta(RunId.make("other-run"), "wrong run"),
          delta(turn.runId, "wrong thread", { threadId: "other-thread" }),
          delta(turn.runId, "wrong item", { itemId: "missing" }),
          delta(turn.runId, "not a string", { chunk: 42 }),
        ]);
        expect(yield* firstFrame(engine)).toEqual(before);
        yield* batch(3, [delta(turn.runId, "accepted")]);
        expect(shown((yield* firstFrame(engine)).text)).toBe("accepted");
      }),
    ),
  );

  it.effect("uses running item snapshots until raw chunks arrive and final item output wins", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        yield* batch(2, [reportCommand(turn.runId, { ...command, output: "x".repeat(90_000) })]);
        const snapshot = yield* firstFrame(engine);
        expect(snapshot.text.length).toBeGreaterThan(60_000);
        expect(snapshot.text.length).toBeLessThanOrEqual(64 * 1024);
        expect(snapshot.truncated).toBe(true);
        yield* batch(3, [reportCommand(turn.runId, { ...command, output: "snapshot update" })]);
        expect(shown((yield* firstFrame(engine)).text)).toBe("snapshot update");
        yield* batch(4, [delta(turn.runId, "live")]);
        yield* batch(5, [reportCommand(turn.runId, { ...command, output: "stale snapshot" })]);
        expect(shown((yield* firstFrame(engine)).text)).toBe("live");
        yield* batch(6, [
          reportCommand(turn.runId, {
            ...command,
            status: "completed",
            output: '{"stdout":"final","stderr":"warning","interrupted":false}',
          }),
        ]);
        expect(yield* firstFrame(engine)).toMatchObject({
          running: false,
          text: "final\nwarning",
          truncated: false,
        });
      }),
    ),
  );

  it.effect("subscribes under the lock and coalesces slow readers to the settled tail", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        const stream = yield* engine.commandOutput(owner, target);
        // All commits happen before the stream starts consuming its invalidations.
        yield* batch(2, [delta(turn.runId, "one"), delta(turn.runId, " two")]);
        yield* batch(3, [reportCommand(turn.runId, { ...command, status: "completed" })]);
        const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
        const collecting = yield* stream.pipe(
          Stream.runForEach((frame) => Queue.offer(frames, frame)),
          Effect.forkChild,
        );
        expect(yield* Queue.take(frames)).toMatchObject({
          kind: "replace",
          text: "",
          running: true,
        });
        yield* TestClock.adjust(500);
        expect(yield* Queue.take(frames)).toMatchObject({
          kind: "replace",
          text: "one two",
          running: false,
        });
        yield* Fiber.join(collecting);
      }),
    ),
  );

  it.effect("ends on owning run completion even if the command row never settled", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, report } = yield* start(engine, runner);
        yield* batch(2, [delta(turn.runId, "before completion"), report.terminal]);
        expect(yield* firstFrame(engine)).toMatchObject({
          text: "before completion",
          running: false,
        });
        yield* batch(3, [delta(turn.runId, "late")]);
        expect(shown((yield* firstFrame(engine)).text)).toBe("before completion");
      }),
    ),
  );

  it.effect("ends a failed run and a lost runner without leaving a loading output stream", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, machine } = yield* start(engine, runner);
        yield* batch(2, [delta(turn.runId, "before crash")]);
        yield* runner.disconnected({
          generation: machine.generation,
          connection: 1,
          detail: "socket lost",
        });
        expect((yield* firstFrame(engine)).running).toBe(true);
        yield* TestClock.adjust(60_000);
        yield* runner.reconcile;
        expect(yield* firstFrame(engine)).toMatchObject({ text: "before crash", running: false });
      }),
    ),
  );

  it.effect("stops output when a user interrupts its run", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn } = yield* start(engine, runner);
        yield* batch(2, [delta(turn.runId, "partial")]);
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            threadId,
            runId: turn.runId,
            commandId: CommandId.make("interrupt"),
          },
          personal,
        );
        expect(yield* firstFrame(engine)).toMatchObject({ text: "partial", running: false });
      }),
    ),
  );
});
