import { OrchestrationV2DomainEventJson } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadStore } from "../ThreadStore.ts";
import { wire } from "../threadWire.ts";
import {
  delta,
  firstFrame,
  freshDatabase,
  owner,
  reportCommand,
  start,
  target,
  withObject,
} from "../commandOutputTestKit.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2DomainEventJson));

describe("command output with current-item history", () => {
  it.effect.each(["command-output", "current-item-history"] as const)(
    "upgrades an object with only %s migrations and preserves canonical output and clipping",
    (existing) =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        const saved = yield* withObject(filename, (engine, runner, context) =>
          Effect.gen(function* () {
            const { turn, machine, command, batch } = yield* start(engine, runner);
            yield* batch(2, [delta(turn.runId, "live prefix\n")]);
            const live = yield* firstFrame(engine);
            const sql = Context.get(context, SqlClient.SqlClient);
            // Simulate either already-deployed migration family, including id 12.
            if (existing === "command-output") {
              yield* sql`DROP TABLE signalbox_turn_item_state`;
              yield* sql`DROP TABLE signalbox_turn_item_backfill`;
              yield* sql`DELETE FROM effect_sql_migrations
                WHERE name IN ('current_item_history', 'current_item_expansion')`;
            } else {
              yield* sql`DROP TABLE command_output`;
              yield* sql`DROP TABLE command_output_cursor`;
              yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'command_output'`;
            }
            return { turn, machine, command, live };
          }),
        );

        const clippedPrefix = `live prefix\n${"x".repeat(29_988)}`;
        const rawOutput = `live prefix\n${"x".repeat(75_000)}\nACTUAL_TAIL\n`;
        const normalOutput = `complete canonical stdout\n${"y".repeat(75_000)}\nfinal stderr\n`;
        const frames = yield* withObject(filename, (engine, runner, context) =>
          Effect.gen(function* () {
            const sql = Context.get(context, SqlClient.SqlClient);
            const store = Context.get(context, ThreadStore);
            expect(
              yield* sql`SELECT migration_id, name FROM effect_sql_migrations
                WHERE migration_id >= 12 ORDER BY migration_id, name`,
            ).toEqual([
              { migration_id: 12, name: "command_output" },
              { migration_id: 12, name: "current_item_history" },
              { migration_id: 12, name: "git_pulls" },
              { migration_id: 12, name: "secret_environment_names" },
              { migration_id: 12, name: "workflow_scripts" },
              { migration_id: 13, name: "current_item_expansion" },
            ]);
            if (existing === "command-output") {
              expect(yield* firstFrame(engine)).toEqual(saved.live);
            } else {
              expect(yield* firstFrame(engine)).toMatchObject({
                text: "",
                truncated: true,
                running: true,
              });
            }
            const batch = (sequence: number, items: Parameters<typeof runner.batch>[0]["items"]) =>
              runner.batch({ generation: saved.machine.generation, sequence, items });
            yield* batch(3, [delta(saved.turn.runId, rawOutput.slice("live prefix\n".length))]);
            const clipped = {
              ...saved.command,
              status: "completed" as const,
              output: clippedPrefix,
              outputTruncated: true,
            };
            yield* batch(4, [reportCommand(saved.turn.runId, clipped)]);
            const frame = yield* firstFrame(engine);
            expect(frame.text.endsWith("ACTUAL_TAIL\n")).toBe(true);
            expect(frame).toMatchObject({ running: false, truncated: true });
            expect(frame.text.length).toBeLessThanOrEqual(64 * 1024);

            const canonical = yield* sql<{
              event: string;
            }>`SELECT event FROM signalbox_turn_item_state
              WHERE item_id = ${target.itemId}`;
            const event = decodeEvent(canonical[0]?.event);
            expect(event.type === "turn-item.updated" ? event.payload : null).toMatchObject({
              output: clippedPrefix,
              outputTruncated: true,
            });
            const snapshot = yield* engine.snapshot(owner);
            const roundTripped = wire.snapshot.decode(wire.snapshot.encode(snapshot));
            expect(
              roundTripped.projection.turnItems.find((item) => item.id === target.itemId),
            ).toMatchObject({ output: clippedPrefix, outputTruncated: true });
            const events = yield* store.events(0);
            const stored = events.findLast(
              (row) =>
                row.event.type === "turn-item.updated" && row.event.payload.id === target.itemId,
            );
            expect(
              stored?.event.type === "turn-item.updated" ? stored.event.payload : null,
            ).toMatchObject({ output: clippedPrefix, outputTruncated: true });

            // A later complete canonical result still replaces the retained raw tail.
            yield* batch(5, [
              reportCommand(saved.turn.runId, {
                ...saved.command,
                status: "completed",
                output: normalOutput,
                outputTruncated: false,
              }),
            ]);
            const completeFrame = yield* firstFrame(engine);
            expect(completeFrame).toMatchObject({
              running: false,
              truncated: true,
            });
            expect(completeFrame.text.endsWith("\nfinal stderr\n")).toBe(true);
            expect(completeFrame.text).not.toContain("ACTUAL_TAIL");
            expect(completeFrame.text.length).toBeLessThanOrEqual(64 * 1024);
            return completeFrame;
          }),
        );
        yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            expect(yield* firstFrame(engine)).toEqual(frames);
            const snapshot = yield* engine.snapshot(owner);
            expect(
              snapshot.projection.turnItems.find((item) => item.id === target.itemId),
            ).toMatchObject({ output: normalOutput, outputTruncated: false });
          }),
        );
      }),
  );
});
