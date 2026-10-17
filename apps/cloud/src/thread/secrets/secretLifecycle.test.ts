import {
  CommandId,
  RunAttemptId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { secretRequestDisplay } from "@t3tools/client-runtime/secret-request";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { finishRunEvents } from "../runLifecycle.ts";
import { recoverRunEvents } from "../runner/runRecovery.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../runnerTesting.ts";
import type { ThreadRunner } from "../runner/ThreadRunner.ts";
import type { ThreadEngine } from "../ThreadEngine.ts";
import { runEvent, turnItemEvent } from "../threadEvents.ts";
import { threadShellFromProjection } from "../threadProjection.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { ThreadSecretRequests } from "./ThreadSecretRequests.ts";

const requestId = TurnItemId.make("persisted-secret-request");
const value = "synthetic-unused-custody";

/** Persist what an old object left behind, with no request fiber or HTTP waiter. */
const seed = (
  engine: ThreadEngine["Service"],
  runner: ThreadRunner["Service"],
  context: Context.Context<ThreadStore | SqlClient.SqlClient>,
  saved = false,
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const machine = yield* connect(runner);
    const turn = yield* liveTurn(runner);
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    yield* runner.batch({ generation: machine.generation, sequence: 1, items: [report.started] });
    const before = yield* snapshot(engine);
    const run = before.projection.runs[0]!;
    const store = Context.get(context, ThreadStore);
    const sql = Context.get(context, SqlClient.SqlClient);
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO signalbox_secret_requests (request_id, run_id, attempt_id, generation, ref, value, saved_at)
    VALUES (${requestId}, ${run.id}, ${run.activeAttemptId}, ${machine.generation}, 'secret-ref:11111111111111111111111111111111', ${saved ? value : null}, ${saved ? now : null})`;
    const item: OrchestrationV2TurnItem = {
      id: requestId,
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1000001,
      status: saved ? "completed" : "waiting",
      title: "Private value",
      startedAt: before.projection.updatedAt,
      completedAt: saved ? before.projection.updatedAt : null,
      updatedAt: before.projection.updatedAt,
      type: "secret_request",
      label: "Private value",
      reason: "Test custody",
      secretStatus: saved ? "saved" : "pending",
    };
    yield* engine.apply((_, ctx) =>
      Effect.succeed({
        events: [
          turnItemEvent(ctx, item),
          runEvent(ctx, "run.updated", { ...run, status: saved ? "running" : "waiting" }),
        ],
        result: undefined,
      }),
    );
    return { run, machine, item, store, sql };
  });

const assertClosed = (item: OrchestrationV2TurnItem | undefined) => {
  expect(item).toMatchObject({
    type: "secret_request",
    secretStatus: "cancelled",
    status: "cancelled",
  });
  if (item?.type !== "secret_request") throw new Error("Expected private card");
  expect(secretRequestDisplay(item, "local").kind).toBe("answered");
};

const assertErased = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows =
      yield* sql`SELECT value, consumed FROM signalbox_secret_requests WHERE request_id = ${requestId}`;
    expect(rows).toEqual([{ value: null, consumed: 1 }]);
  });

describe("durable private request lifecycle", () => {
  it.effect.each(["completed", "interrupted", "failed", "recovery"] as const)(
    "cancels a waiterless card on %s and keeps it cancelled after reload",
    (ending) => {
      const database = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(database, (engine, runner, context) =>
          Effect.gen(function* () {
            const { run, item } = yield* seed(engine, runner, context);
            if (ending === "interrupted") {
              yield* engine.dispatch(
                owner,
                {
                  type: "run.interrupt",
                  commandId: CommandId.make("stop-without-waiter"),
                  threadId,
                  runId: run.id,
                },
                { pools: null, place: null },
              );
            } else
              yield* engine.apply((projection, ctx) => {
                if (projection === null) throw new Error("Expected projection");
                const live = projection.runs.find((candidate) => candidate.id === run.id)!;
                return Effect.succeed({
                  events:
                    ending === "recovery"
                      ? recoverRunEvents(projection, live, ctx)
                      : finishRunEvents(projection, live, ending, ctx),
                  result: undefined,
                });
              });
            assertClosed(
              (yield* engine.projection)?.turnItems.find((candidate) => candidate.id === requestId),
            );
            // A late interrupted provider row must not revive the card's pending input.
            yield* engine.apply((_, ctx) =>
              Effect.succeed({
                events: [turnItemEvent(ctx, { ...item, status: "interrupted" })],
                result: undefined,
              }),
            );
            assertClosed(
              (yield* engine.projection)?.turnItems.find((candidate) => candidate.id === requestId),
            );
          }),
        );
        yield* withObject(database, (engine) =>
          Effect.gen(function* () {
            const projection = (yield* snapshot(engine)).projection;
            assertClosed(projection.turnItems.find((candidate) => candidate.id === requestId));
            expect(
              projection.turnItems.filter(
                (item) => item.type === "secret_request" && item.secretStatus === "pending",
              ),
            ).toEqual([]);
            expect(threadShellFromProjection(projection).pendingRuntimeRequest).toBeNull();
          }),
        );
      });
    },
  );

  it.effect.each(["ended", "live"] as const)(
    "repairs a persisted %s run's orphan without a waiter on startup",
    (state) => {
      const database = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(database, (engine, runner, context) =>
          Effect.gen(function* () {
            const { run, store } = yield* seed(engine, runner, context);
            if (state === "ended") {
              const before = yield* snapshot(engine);
              // Bypass the engine to reproduce a log written by the old build.
              yield* store.commit({
                head: before.head,
                events: [
                  runEvent({ now: before.projection.updatedAt }, "run.updated", {
                    ...run,
                    status: "interrupted",
                    completedAt: before.projection.updatedAt,
                  }),
                ],
                summaryChanged: true,
              });
            }
          }),
        );
        const repaired = yield* withObject(database, (engine, _, context) =>
          Effect.gen(function* () {
            const after = yield* snapshot(engine);
            assertClosed(after.projection.turnItems.find((item) => item.id === requestId));
            expect(threadShellFromProjection(after.projection).pendingRuntimeRequest).toBeNull();
            expect(after.projection.runs[0]?.status).toBe(
              state === "ended" ? "interrupted" : "running",
            );
            yield* assertErased(Context.get(context, SqlClient.SqlClient));
            return after.head;
          }),
        );
        yield* withObject(database, (engine) =>
          Effect.gen(function* () {
            expect((yield* snapshot(engine)).head).toBe(repaired);
          }),
        );
      });
    },
  );

  it.effect.each([
    "completed",
    "interrupted",
    "failed",
    "recovery",
    "generation",
    "attempt",
  ] as const)("erases saved unused custody on %s", (ending) =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { run, store, sql } = yield* seed(engine, runner, context, true);
        const machine = yield* store.machine;
        yield* engine.apply((projection, ctx) => {
          if (projection === null) throw new Error("Expected projection");
          return Effect.succeed({
            events:
              ending === "generation"
                ? []
                : ending === "attempt"
                  ? [
                      runEvent(ctx, "run.updated", {
                        ...run,
                        activeAttemptId: RunAttemptId.make("replacement-attempt"),
                      }),
                    ]
                  : ending === "recovery"
                    ? recoverRunEvents(projection, run, ctx)
                    : finishRunEvents(projection, run, ending, ctx),
            ...(ending === "generation" && machine.status !== "none"
              ? { machine: { ...machine, generation: machine.generation + 1 } }
              : {}),
            result: undefined,
          });
        });
        yield* assertErased(sql);
        expect(
          (yield* engine.projection)?.turnItems.find((item) => item.id === requestId),
        ).toMatchObject({ secretStatus: "saved" });
        expect(JSON.stringify(yield* snapshot(engine))).not.toContain(value);
      }),
    ),
  );

  it.effect.each(["ended", "expired", "valid"] as const)(
    "sweeps %s custody on reopen without another request",
    (state) => {
      const database = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(database, (engine, runner, context) =>
          Effect.gen(function* () {
            const { run, store } = yield* seed(engine, runner, context, true);
            if (state === "ended") {
              const before = yield* snapshot(engine);
              yield* store.commit({
                head: before.head,
                events: [
                  runEvent({ now: before.projection.updatedAt }, "run.updated", {
                    ...run,
                    status: "completed",
                    completedAt: before.projection.updatedAt,
                  }),
                ],
                summaryChanged: true,
              });
            }
          }),
        );
        if (state === "expired") yield* TestClock.adjust(86_400_001);
        yield* withObject(database, (engine, _, context) =>
          Effect.gen(function* () {
            const sql = Context.get(context, SqlClient.SqlClient);
            if (state === "valid") {
              expect(
                yield* sql`SELECT value, consumed FROM signalbox_secret_requests WHERE request_id = ${requestId}`,
              ).toEqual([{ value, consumed: 0 }]);
            } else yield* assertErased(sql);
            expect(JSON.stringify(yield* snapshot(engine))).not.toContain(value);
          }),
        );
      });
    },
  );
  it.effect("rolls custody cleanup back when the durable run-end commit fails", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { run, sql } = yield* seed(engine, runner, context, true);
        yield* sql`CREATE TRIGGER fail_run_end BEFORE INSERT ON events
        WHEN json_extract(NEW.event, '$.type') = 'run.updated'
        BEGIN SELECT RAISE(FAIL, 'synthetic commit failure'); END`;
        const finish = engine.apply((projection, ctx) => {
          if (projection === null) throw new Error("Expected projection");
          return Effect.succeed({
            events: finishRunEvents(projection, run, "completed", ctx),
            result: undefined,
          });
        });
        expect((yield* Effect.exit(finish))._tag).toBe("Failure");
        expect(
          yield* sql`SELECT value, consumed FROM signalbox_secret_requests WHERE request_id = ${requestId}`,
        ).toEqual([{ value, consumed: 0 }]);
        expect((yield* engine.projection)?.runs[0]?.status).toBe("running");
        yield* sql`DROP TRIGGER fail_run_end`;
        yield* finish;
        yield* assertErased(sql);
      }),
    ),
  );

  it.effect(
    "keeps custody before a failed card commit and preserves the first answer on retry",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          const { sql } = yield* seed(engine, runner, context);
          const secrets = Context.get(context, ThreadSecretRequests);
          yield* sql`CREATE TRIGGER fail_saved_card BEFORE INSERT ON events
        WHEN json_extract(NEW.event, '$.payload.secretStatus') = 'saved'
        BEGIN SELECT RAISE(FAIL, 'synthetic card failure'); END`;
          const answer = (secret: string) =>
            secrets.answer(owner, {
              threadId,
              turnItemId: requestId,
              answer: { type: "save", secret },
            });
          expect((yield* Effect.exit(answer(value)))._tag).toBe("Failure");
          expect(
            yield* sql`SELECT value, consumed FROM signalbox_secret_requests WHERE request_id = ${requestId}`,
          ).toEqual([{ value, consumed: 0 }]);
          expect(
            (yield* engine.projection)?.turnItems.find((item) => item.id === requestId),
          ).toMatchObject({ secretStatus: "pending" });
          yield* sql`DROP TRIGGER fail_saved_card`;
          yield* answer("replacement-must-not-win");
          expect(
            yield* sql`SELECT value, consumed FROM signalbox_secret_requests WHERE request_id = ${requestId}`,
          ).toEqual([{ value, consumed: 0 }]);
          expect(
            (yield* engine.projection)?.turnItems.find((item) => item.id === requestId),
          ).toMatchObject({ secretStatus: "saved" });
          expect(yield* answer("another-replacement").pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "already_answered" },
          });
          expect(JSON.stringify(yield* snapshot(engine))).not.toContain(value);
        }),
      ),
  );
});
