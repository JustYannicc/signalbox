/**
 * Reads `workload.turn.completed` events for the cost replay, from PostHog's
 * query API or from an exported file.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { ReplayTurn } from "./workload-replay.ts";

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
export const decodeExport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ExportedTurn)),
);
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
