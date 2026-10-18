import { type OrchestrationV2CommandOutputFrame, TurnItemId } from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  TERMINAL_OUTPUT_TAIL_CHARS,
} from "@t3tools/shared/terminalOutput";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ThreadStore } from "../ThreadStore.ts";
import {
  MAX_COMMAND_OUTPUT_TAILS,
  delta,
  firstFrame,
  freshDatabase,
  owner,
  reportCommand,
  start,
  target,
  withObject,
} from "../commandOutputTestKit.ts";

describe("cloud command output retention", () => {
  it.effect("bounds raw delta tails and persists truncation through a restart", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const saved = yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          const { batch, turn } = yield* start(engine, runner);
          yield* batch(2, [
            delta(turn.runId, "x".repeat(100_000)),
            delta(turn.runId, "\nlast line"),
          ]);
          const frame = yield* firstFrame(engine);
          expect(frame.text.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_TAIL_CHARS);
          expect(frame.text.endsWith("last line")).toBe(true);
          expect(frame.truncated).toBe(true);
          return frame;
        }),
      );
      yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          expect(yield* firstFrame(engine)).toEqual(saved);
        }),
      );
    }),
  );

  it.effect("retains at most 64 commands and reports an evicted tail honestly", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        yield* batch(2, [delta(turn.runId, "old command")]);
        const commands = Array.from({ length: MAX_COMMAND_OUTPUT_TAILS }, (_, index) => ({
          ...command,
          id: TurnItemId.make(`new-${index}`),
        }));
        yield* batch(
          3,
          commands.flatMap((item) => [
            reportCommand(turn.runId, item),
            delta(turn.runId, `output ${item.id}`, { itemId: item.id }),
          ]),
        );
        const sql = Context.get(context, SqlClient.SqlClient);
        expect(yield* sql`SELECT COUNT(*) AS count FROM command_output`).toEqual([{ count: 64 }]);
        expect(yield* firstFrame(engine)).toMatchObject({
          text: "",
          running: true,
          truncated: true,
        });
        yield* batch(4, [reportCommand(turn.runId, { ...command, status: "failed" })]);
        expect(yield* firstFrame(engine)).toMatchObject({
          text: "",
          running: false,
          truncated: true,
        });
      }),
    ),
  );

  it.effect("marks missing output on a command first seen already settled", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        const finished = {
          ...command,
          id: TurnItemId.make("already-done"),
          status: "completed" as const,
        };
        yield* batch(2, [reportCommand(turn.runId, finished)]);
        expect(yield* firstFrame(engine, { ...target, itemId: finished.id })).toMatchObject({
          text: "",
          running: false,
          truncated: true,
        });
      }),
    ),
  );

  it.effect("rolls the output and ack back together if tail persistence fails", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { batch, turn } = yield* start(engine, runner);
        const store = Context.get(context, ThreadStore);
        const sql = Context.get(context, SqlClient.SqlClient);
        const before = yield* firstFrame(engine);
        yield* sql`CREATE TRIGGER reject_output BEFORE INSERT ON command_output
          WHEN NEW.resume_text = 'reject' BEGIN SELECT RAISE(ABORT, 'test write failure'); END`;
        expect(Exit.isFailure(yield* Effect.exit(batch(2, [delta(turn.runId, "reject")])))).toBe(
          true,
        );
        expect((yield* store.machine).ackedSequence).toBe(1);
        expect(yield* firstFrame(engine)).toEqual(before);
        yield* sql`DROP TRIGGER reject_output`;
        yield* batch(2, [delta(turn.runId, "accepted")]);
        expect((yield* store.machine).ackedSequence).toBe(2);
        expect((yield* firstFrame(engine)).text).toBe("accepted");
      }),
    ),
  );

  it.effect(
    "appends safe growth, then reconnects with a replace snapshot without duplication",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { batch, turn, command } = yield* start(engine, runner);
          yield* batch(2, [delta(turn.runId, "one")]);
          const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
          const stream = yield* engine.commandOutput(owner, target);
          const collecting = yield* stream.pipe(
            Stream.runForEach((frame) => Queue.offer(frames, frame)),
            Effect.forkChild,
          );
          const initial = yield* Queue.take(frames);
          expect(initial).toMatchObject({ kind: "replace", text: "one" });
          yield* batch(3, [delta(turn.runId, " two")]);
          yield* TestClock.adjust(500);
          const append = yield* Queue.take(frames);
          expect(append).toMatchObject({ kind: "append", text: " two", running: true });
          expect(append.sequence).toBeGreaterThan(initial.sequence!);
          const reconnect = yield* firstFrame(engine);
          expect(reconnect).toMatchObject({
            kind: "replace",
            text: "one two",
            sequence: append.sequence,
          });
          const client = appendTerminalOutput(
            appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, initial.text),
            append.text,
          );
          expect(appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, reconnect.text).text).toBe(
            client.text,
          );
          yield* batch(4, [
            reportCommand(turn.runId, { ...command, status: "completed", output: "final" }),
          ]);
          yield* TestClock.adjust(500);
          expect(yield* Queue.take(frames)).toMatchObject({
            kind: "replace",
            text: "final",
            running: false,
          });
          yield* Fiber.join(collecting);
        }),
      ),
  );
});
