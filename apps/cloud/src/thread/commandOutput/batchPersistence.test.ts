import { type RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { TurnItemId } from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputResumeText,
} from "@t3tools/shared/terminalOutput";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadStore } from "../ThreadStore.ts";
import {
  MAX_COMMAND_OUTPUT_TAILS,
  delta,
  firstFrame,
  freshDatabase,
  reportCommand,
  start,
  target,
  withObject,
} from "../commandOutputTestKit.ts";

describe("command output batch persistence", () => {
  it.effect("folds 256 interleaved chunks in order and writes each command only once", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        const second = { ...command, id: TurnItemId.make("second-command") };
        const createdInBatch = { ...command, id: TurnItemId.make("new-command") };
        const initial = `${"history\n".repeat(8_000)}base\u001b[`;
        const secondInitial = `${"history\n".repeat(8_000)}other`;
        yield* batch(2, [
          reportCommand(turn.runId, second),
          delta(turn.runId, initial),
          delta(turn.runId, secondInitial, { itemId: second.id }),
        ]);
        const sql = Context.get(context, SqlClient.SqlClient);
        const store = Context.get(context, ThreadStore);
        yield* sql`CREATE TABLE output_writes (item_id TEXT NOT NULL)`;
        yield* sql`CREATE TRIGGER count_output_writes BEFORE INSERT ON command_output
          BEGIN INSERT INTO output_writes (item_id) VALUES (NEW.item_id); END`;
        const firstChunks = Array.from(
          { length: 128 },
          (_, index) =>
            ["31m", "progress", "\r", "\u001b[2", "K", "done\u001b[0m\n", "\u001b[", "32m"][
              index % 8
            ]!,
        );
        const secondChunks = Array.from(
          { length: 128 },
          (_, index) => ["\u001b", "7", "abc", "\u001b[", "2D", "XY", "\u001b", "8"][index % 8]!,
        );
        const items: Array<RunnerItem> = firstChunks.flatMap((chunk, index) => [
          delta(turn.runId, chunk),
          delta(turn.runId, secondChunks[index]!, { itemId: second.id }),
        ]);
        items.push(
          reportCommand(turn.runId, createdInBatch),
          delta(turn.runId, "new\u001b[", { itemId: createdInBatch.id }),
          delta(turn.runId, "31m red", { itemId: createdInBatch.id }),
        );
        yield* batch(3, items);
        expect(
          yield* sql`SELECT item_id, COUNT(*) AS count FROM output_writes
          GROUP BY item_id ORDER BY item_id`,
        ).toEqual([
          { item_id: command.id, count: 1 },
          { item_id: createdInBatch.id, count: 1 },
          { item_id: second.id, count: 1 },
        ]);
        const expectedFirst = firstChunks.reduce(
          (state, chunk) => appendTerminalOutput(state, chunk),
          appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, initial),
        );
        const expectedSecond = secondChunks.reduce(
          (state, chunk) => appendTerminalOutput(state, chunk),
          appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, secondInitial),
        );
        expect(yield* store.commandOutput({ itemId: command.id, runId: turn.runId })).toEqual({
          text: terminalOutputResumeText(expectedFirst),
          truncated: expectedFirst.truncated,
          hasChunks: true,
        });
        expect(yield* store.commandOutput({ itemId: second.id, runId: turn.runId })).toEqual({
          text: terminalOutputResumeText(expectedSecond),
          truncated: expectedSecond.truncated,
          hasChunks: true,
        });
        expect(
          (yield* firstFrame(engine, { ...target, itemId: createdInBatch.id })).text,
        ).toContain("red");
      }),
    ),
  );

  it.effect("evicts by last use rather than the first appearance of grouped deltas", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { batch, turn, command } = yield* start(engine, runner);
        const commands = Array.from({ length: MAX_COMMAND_OUTPUT_TAILS }, (_, index) => ({
          ...command,
          id: TurnItemId.make(`other-command-${index}`),
        }));
        yield* batch(2, [
          delta(turn.runId, "old"),
          ...commands.flatMap((item) => [
            reportCommand(turn.runId, item),
            delta(turn.runId, "new", { itemId: item.id }),
          ]),
          delta(turn.runId, " newest"),
        ]);
        expect((yield* firstFrame(engine)).text).toBe("old newest");
        expect(yield* firstFrame(engine, { ...target, itemId: commands[0]!.id })).toMatchObject({
          text: "",
          truncated: true,
        });
        const sql = Context.get(context, SqlClient.SqlClient);
        expect(yield* sql`SELECT COUNT(*) AS count FROM command_output`).toEqual([{ count: 64 }]);
      }),
    ),
  );
});
