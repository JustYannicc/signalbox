#!/usr/bin/env node
/**
 * Prices the last N days of `workload.turn.completed` events against every
 * machine price table and prints #116's table: per idle tail, the machine's
 * awake hours, wakes, and dollars per active user-day.
 *
 *   POSTHOG_PERSONAL_API_KEY=… POSTHOG_PROJECT_ID=… node scripts/workload-cost-replay.ts
 *   node scripts/workload-cost-replay.ts --events export.json
 *
 * The personal API key needs the `query:read` scope. `--events` reads a JSON
 * array of `{ distinct_id, timestamp, properties }`, as PostHog exports them.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { MACHINE_PRICES } from "./lib/workload-prices.ts";
import { decodeExport, fetchTurns, toReplayTurn } from "./lib/workload-events.ts";
import { formatReplayTable, replay } from "./lib/workload-replay.ts";

const readTurns = Effect.fn("readTurns")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const rows = yield* decodeExport(yield* fs.readFileString(file));
  return rows.map(toReplayTurn);
});

export const workloadCostReplayCommand = Command.make(
  "workload-cost-replay",
  {
    days: Flag.Int("days").pipe(
      Flag.withDescription("How many days of events to replay."),
      Flag.withDefault(30),
    ),
    events: Flag.String("events").pipe(
      Flag.withDescription("Replay an exported JSON file instead of querying PostHog."),
      Flag.optional,
    ),
    tails: Flag.String("tails").pipe(
      Flag.withDescription("Comma-separated idle tails in seconds."),
      Flag.withDefault("30,300,600"),
    ),
  },
  ({ days, events, tails }) =>
    Effect.gen(function* () {
      const turns = yield* Option.match(events, {
        onNone: () => fetchTurns(days),
        onSome: readTurns,
      });
      const idleTails = tails.split(",").map((tail) => Number(tail.trim()));
      const result = replay(turns, MACHINE_PRICES, idleTails);
      yield* Console.log(formatReplayTable(result, MACHINE_PRICES));
      yield* Console.log(
        `\n${result.turns} turns over ${result.userDays} active user-days; ` +
          `${result.measuredCpuTurns} with measured CPU, the rest assumed.`,
      );
    }),
).pipe(Command.withDescription("Price workload analytics against machine price tables."));

if (import.meta.main) {
  Command.run(workloadCostReplayCommand, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
