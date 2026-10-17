import { TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import type { ThreadEngine } from "../ThreadEngine.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { runEvent, turnItemEvent } from "../threadEvents.ts";
import { threadShellFromProjection } from "../threadProjection.ts";
import {
  type ThreadRunner,
  connect,
  freshDatabase,
  launch,
  snapshot,
  threadId,
  withObject,
} from "../runnerTesting.ts";

/** Node SQLite allows more bindings than DO SQLite. Enforce the production limit before execution. */
const capped = <A, E, R>(effect: Effect.Effect<A, E, R>, retirements: Array<number>) =>
  effect.pipe(
    Effect.provideService(Statement.CurrentTransformer, (statement) =>
      Effect.sync(() => {
        const [query, params] = statement.compile();
        if (params.length > 100)
          throw new Error(`DO SQLite bind limit exceeded: ${params.length} > 100`);
        if (query.includes("UPDATE signalbox_secret_requests") && query.includes("request_id IN"))
          retirements.push(params.length);
        return statement;
      }),
    ),
  );

const seed = (
  engine: ThreadEngine["Service"],
  runner: ThreadRunner["Service"],
  context: Context.Context<ThreadStore | SqlClient.SqlClient>,
  state: "pending" | "terminal" | "ended",
  persisted = true,
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const machine = yield* connect(runner);
    const before = yield* snapshot(engine);
    const run = before.projection.runs[0]!;
    const sql = Context.get(context, SqlClient.SqlClient);
    const now = yield* Clock.currentTimeMillis;
    const items = Array.from({ length: 205 }, (_, i): OrchestrationV2TurnItem => ({
      id: TurnItemId.make(`secret-card-${i}`),
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1000001 + i,
      status: state === "terminal" ? "cancelled" : "waiting",
      title: "Private request",
      startedAt: before.projection.updatedAt,
      completedAt: state === "terminal" ? before.projection.updatedAt : null,
      updatedAt: before.projection.updatedAt,
      type: "secret_request",
      label: "Private request",
      reason: "Test limit",
      secretStatus: state === "terminal" ? (i % 2 === 0 ? "cancelled" : "declined") : "pending",
    }));
    for (const item of items) {
      yield* sql`INSERT INTO signalbox_secret_requests (request_id, run_id, attempt_id, generation, ref, value, saved_at, consumed)
      VALUES (${item.id}, ${run.id}, ${run.activeAttemptId}, ${machine.generation}, ${`test-ref:${item.id}`}, ${state === "terminal" ? null : "synthetic-private-fixture"}, ${now}, ${state === "terminal" ? 1 : 0})`;
    }
    const events = [
      ...items.map((item) => turnItemEvent({ now: before.projection.updatedAt }, item)),
      runEvent({ now: before.projection.updatedAt }, "run.updated", {
        ...run,
        status: state === "ended" ? "completed" : state === "pending" ? "waiting" : "running",
      }),
    ];
    if (persisted) {
      // An older object's persisted rows, loaded by the next object, without a live waiter.
      yield* Context.get(context, ThreadStore).commit({
        head: before.head,
        events,
        summaryChanged: true,
      });
    } else yield* engine.apply(() => Effect.succeed({ events, result: undefined }));
    return { run, sql, items };
  });

const erased = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows =
      yield* sql`SELECT COUNT(*) AS count FROM signalbox_secret_requests WHERE value IS NOT NULL OR consumed = 0`;
    expect(rows).toEqual([{ count: 0 }]);
  });

describe("private custody under the DO SQLite binding limit", () => {
  it.effect.each(["pending", "terminal", "ended"] as const)(
    "reopens 205 %s cards without exceeding 100 bindings",
    (state) => {
      const database = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(database, (engine, runner, context) =>
          seed(engine, runner, context, state),
        );
        const retirements: Array<number> = [];
        yield* capped(
          withObject(database, (engine, _, context) =>
            Effect.gen(function* () {
              const projection = (yield* snapshot(engine)).projection;
              expect(
                projection.turnItems.filter(
                  (item) => item.type === "secret_request" && item.secretStatus === "pending",
                ),
              ).toEqual([]);
              expect(threadShellFromProjection(projection).pendingRuntimeRequest).toBeNull();
              yield* erased(Context.get(context, SqlClient.SqlClient));
            }),
          ),
          retirements,
        );
        expect(retirements).toEqual(state === "pending" ? [90, 90, 25] : []);
      });
    },
  );

  it.effect("chunks a large newly cancelled batch while its run is still live", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { items, sql } = yield* seed(engine, runner, context, "pending", false);
        const retirements: Array<number> = [];
        yield* capped(
          engine.apply((_, ctx) =>
            Effect.succeed({
              events: items.map((item) =>
                turnItemEvent(ctx, {
                  ...item,
                  status: "cancelled",
                  ...(item.type === "secret_request" ? { secretStatus: "cancelled" as const } : {}),
                }),
              ),
              result: undefined,
            }),
          ),
          retirements,
        );
        expect(retirements).toEqual([90, 90, 25]);
        yield* erased(sql);
        expect(
          (yield* engine.projection)?.turnItems.filter(
            (item) => item.type === "secret_request" && item.secretStatus === "pending",
          ),
        ).toEqual([]);
      }),
    ),
  );

  it.effect("does not retire historical terminal cards again on an ordinary commit", () => {
    const database = freshDatabase();
    return Effect.gen(function* () {
      yield* withObject(database, (engine, runner, context) =>
        seed(engine, runner, context, "terminal"),
      );
      // Keep startup uncapped here so this regression isolates the next ordinary commit.
      yield* withObject(database, (engine) =>
        Effect.gen(function* () {
          const retirements: Array<number> = [];
          yield* capped(
            engine.apply((projection, ctx) => {
              if (projection === null) throw new Error("Expected projection");
              return Effect.succeed({
                events: [
                  runEvent(ctx, "run.updated", { ...projection.runs[0]!, status: "running" }),
                ],
                result: undefined,
              });
            }),
            retirements,
          );
          expect(retirements).toEqual([]);
        }),
      );
    });
  });
});
