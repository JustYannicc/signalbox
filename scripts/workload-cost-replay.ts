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
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { MACHINE_PRICES } from "./lib/workload-prices.ts";
import { formatReplayTable, replay, type ReplayTurn } from "./lib/workload-replay.ts";

// Recorded by apps/server/src/signalbox/analytics/workload/WorkloadAnalytics.ts.
const TURN_EVENT = "workload.turn.completed";
const PAGE_SIZE = 10_000;

// HogQL returns nested and numeric properties as JSON text or numbers,
// depending on what PostHog inferred; accept both.
const Numeric = Schema.Union([Schema.Number, Schema.NumberFromString]);
const CommandSeconds = Schema.Record(Schema.String, Schema.Number);

const TurnProperties = Schema.Struct({
  threadHash: Schema.String,
  durationSeconds: Numeric,
  commandSeconds: Schema.optional(
    Schema.Union([CommandSeconds, Schema.fromJsonString(CommandSeconds)]),
  ),
  processCpuSeconds: Schema.optional(Schema.NullOr(Numeric)),
});
const ExportedTurn = Schema.Struct({
  distinct_id: Schema.String,
  timestamp: Schema.Union([Schema.String, Schema.Number]),
  properties: Schema.Union([TurnProperties, Schema.fromJsonString(TurnProperties)]),
});
type ExportedTurn = typeof ExportedTurn.Type;
const decodeExport = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ExportedTurn)));
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ExportedTurn));

const QueryResponse = Schema.Struct({
  results: Schema.Array(Schema.Tuple([Schema.String, Schema.Number, Schema.Unknown])),
});

export function toReplayTurn(row: ExportedTurn): ReplayTurn {
  const endedAtMs = typeof row.timestamp === "number" ? row.timestamp : Date.parse(row.timestamp);
  const commandSeconds = Object.values(row.properties.commandSeconds ?? {}).reduce(
    (sum, seconds) => sum + seconds,
    0,
  );
  return {
    userId: row.distinct_id,
    threadId: row.properties.threadHash,
    endedAtMs,
    durationSeconds: row.properties.durationSeconds,
    commandSeconds,
    cpuSeconds: row.properties.processCpuSeconds ?? undefined,
  };
}

const PostHogConfig = Config.all({
  key: Config.Redacted("POSTHOG_PERSONAL_API_KEY"),
  projectId: Config.String("POSTHOG_PROJECT_ID"),
  host: Config.String("POSTHOG_HOST").pipe(Config.withDefault("https://us.posthog.com")),
});

export const fetchTurns = Effect.fn("fetchTurns")(function* (days: number, pageSize = PAGE_SIZE) {
  const config = yield* PostHogConfig;
  const http = yield* HttpClient.HttpClient;
  const turns: Array<ReplayTurn> = [];
  for (let offset = 0; ; offset += pageSize) {
    const query = `SELECT distinct_id, toUnixTimestamp64Milli(timestamp), properties
      FROM events
      WHERE event = '${TURN_EVENT}' AND timestamp >= now() - INTERVAL ${days} DAY
      ORDER BY timestamp, uuid
      LIMIT ${pageSize} OFFSET ${offset}`;
    const response = yield* HttpClientRequest.post(
      `${config.host.replace(/\/+$/, "")}/api/projects/${config.projectId}/query/`,
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.value(config.key)),
      HttpClientRequest.bodyJson({ query: { kind: "HogQLQuery", query } }),
      Effect.flatMap(http.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(QueryResponse)),
    );
    const rows = yield* decodeRows(
      response.results.map(([distinctId, timestamp, properties]) => ({
        distinct_id: distinctId,
        timestamp,
        properties,
      })),
    );
    turns.push(...rows.map(toReplayTurn));
    if (response.results.length < pageSize) return turns;
  }
});

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
