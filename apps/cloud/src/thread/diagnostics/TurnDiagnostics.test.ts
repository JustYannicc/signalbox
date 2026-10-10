import type { MachineUsage, RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { ProviderTurnId, type RunId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { CONNECT_TIMEOUT_MS } from "../runner/MachineBackend.ts";
import {
  claudeDriver,
  connect,
  encodeTurnItem,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  threadId,
  turnReport,
  withObject,
} from "../runner/runnerTestKit.ts";
import * as ThreadRunner from "../runner/ThreadRunner.ts";
import type * as ThreadEngine from "../ThreadEngine.ts";
import * as CloudAnalytics from "./CloudAnalytics.ts";
import { TurnDiagnostics } from "./TurnDiagnostics.ts";
import { FINALIZE_GRACE_MS, TurnReports } from "./TurnReports.ts";

const usage = (runId: RunId | null, cpuSeconds: number, memoryBytes: number): RunnerItem => ({
  kind: "usage",
  runId,
  usage: {
    cpuSeconds,
    memoryBytes,
    memoryPeakBytes: memoryBytes,
    memoryAverageBytes: memoryBytes,
    diskUsedBytes: 4_000_000_000,
    egressBytes: 1_000_000,
  } satisfies MachineUsage,
});

/** A PostHog that records each batch's request body. */
const layerPostHog = (sent: Array<unknown>) =>
  CloudAnalytics.layerOn({ key: "phc_test", host: "https://posthog.test" }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag === "Uint8Array") {
              sent.push(JSON.parse(new TextDecoder().decode(request.body.body)));
            }
            return HttpClientResponse.fromWeb(request, Response.json({ status: 1 }));
          }),
        ),
      ),
    ),
  );

const projectionOf = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.snapshot(owner), ({ projection }) => projection);

const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

interface PostHogBatch {
  readonly api_key: string;
  readonly batch: ReadonlyArray<{
    readonly event: string;
    readonly distinct_id: string;
    readonly properties: unknown;
  }>;
}

describe("TurnDiagnostics", () => {
  it.effect("explains a turn whose machine never came up", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const reports = Context.get(context, TurnReports);
        yield* launch(engine);
        expect((yield* runner.reconcile).ensure).not.toBeNull();
        yield* TestClock.adjust(CONNECT_TIMEOUT_MS + 1);
        expect((yield* runner.reconcile).release).toBe(1);

        // Not before the grace: the ModelGateway may still report.
        const due = yield* reports.finalize(yield* projectionOf(engine), yield* nowMs);
        expect(due).toBe((yield* nowMs) + FINALIZE_GRACE_MS);
        yield* TestClock.adjust(FINALIZE_GRACE_MS);
        const projection = yield* projectionOf(engine);
        expect(yield* reports.finalize(projection, yield* nowMs)).toBeNull();

        const listed = yield* reports.list(projection);
        expect(listed).toMatchObject([
          { status: "failed", failure: { message: "No machine came up to run this turn." } },
        ]);
        const record = yield* reports.turn(projection, listed[0]!.traceId);
        if (record === null) throw new Error("expected the turn's record");
        // The launch command's id finds the same turn.
        expect((yield* reports.turn(projection, "launch-1"))?.traceId).toBe(record.traceId);
        expect(record).toMatchObject({
          machines: [{ generation: 1, backend: "none", readyAt: null, stopReason: "error" }],
        });
        expect(record.log.map((line) => line.message)).toEqual([
          "Asked the none backend for machine generation 1.",
          "Released machine generation 1 (error): No Runner connected within 60 s.",
        ]);
      }),
    ),
  );

  it.effect("carries one trace id and reports a turn and its machine without content", () => {
    const sent: Array<unknown> = [];
    return withObject(
      freshDatabase(),
      (engine, runner, context) =>
        Effect.gen(function* () {
          const diagnostics = Context.get(context, TurnDiagnostics);
          const reports = Context.get(context, TurnReports);
          const analytics = Context.get(context, CloudAnalytics.CloudAnalytics);
          const sql = Context.get(context, SqlClient.SqlClient);
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          const batch = (sequence: number, items: ReadonlyArray<RunnerItem>) =>
            runner.batch({ generation: machine.generation, sequence, items });
          const command = {
            kind: "provider",
            runId: turn.runId,
            event: {
              driver: claudeDriver,
              type: "turn_item.updated",
              turnItem: encodeTurnItem({
                id: TurnItemId.make(`command:${turn.runId}`),
                threadId,
                runId: turn.runId,
                nodeId: null,
                providerThreadId: turn.providerThread.id,
                providerTurnId: ProviderTurnId.make(`claude-turn:${turn.runId}`),
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 3,
                status: "completed",
                title: null,
                startedAt: DateTime.makeUnsafe(0),
                completedAt: DateTime.makeUnsafe(2_500),
                updatedAt: DateTime.makeUnsafe(2_500),
                type: "command_execution",
                input: "pnpm test src/secret-project/notes.test.ts",
              }) as Record<string, unknown>,
            },
          } satisfies RunnerItem;

          yield* batch(1, [usage(turn.runId, 10, 300_000_000), report.started]);
          yield* batch(2, [command, report.partial]);
          // A resent batch adds nothing twice.
          yield* batch(2, [command, report.partial]);
          yield* diagnostics.modelRequest(
            {
              provider: "anthropic",
              method: "POST",
              path: "/v1/messages",
              status: 200,
              threadId,
              runId: turn.runId,
              traceId: turn.traceId,
              authMs: 2,
              upstreamHeadersMs: 300,
              firstChunkMs: 420,
              addedMs: 12,
              totalMs: 1_800,
              outcome: "complete",
              model: "claude-fable-5-1-20261001",
              usage: { input: 1_200, output: 340, cacheRead: 9_000, cacheWrite: 500 },
            },
            yield* nowMs,
          );
          yield* batch(3, [
            {
              kind: "log",
              runId: turn.runId,
              level: "warning",
              message: "native resume failed; starting a fresh session: no such session",
            },
            report.full,
            report.terminal,
          ]);
          // The turn's last sample arrives after it ended.
          yield* batch(4, [usage(turn.runId, 14.5, 450_000_000)]);
          expect((yield* runner.reconcile).release).toBeNull();

          // The receipt, the Runner's turn and the record name the same trace.
          const receipts = yield* sql<{ readonly trace_id: string }>`SELECT trace_id FROM receipts`;
          expect(receipts.map((row) => row.trace_id)).toEqual([turn.traceId]);

          yield* TestClock.adjust(FINALIZE_GRACE_MS);
          yield* reports.finalize(yield* projectionOf(engine), yield* nowMs);
          const record = yield* reports.turn(yield* projectionOf(engine), turn.traceId);
          if (record === null) throw new Error("expected the turn's record");
          expect(record).toMatchObject({
            traceId: turn.traceId,
            status: "completed",
            usage: { cpuSeconds: 4.5, memoryPeakBytes: 450_000_000 },
            machines: [{ runner: { imageVersion: "test", machineId: "machine-1" } }],
          });
          expect(record.log.map((line) => line.source)).toEqual([
            "thread",
            "thread",
            "gateway",
            "runner",
          ]);
          expect(record.log[2]?.message).toContain("gateway added 12 ms");

          // The idle tail ends the machine's session.
          yield* TestClock.adjust(ThreadRunner.IDLE_TAIL_MS);
          expect((yield* runner.reconcile).release).toBe(machine.generation);
          yield* reports.finalize(yield* projectionOf(engine), yield* nowMs);
          expect(yield* analytics.deliver).toBe(true);
          expect(yield* analytics.hasPending).toBe(false);

          expect(sent).toHaveLength(1);
          const body = sent[0] as PostHogBatch;
          expect(body.api_key).toBe("phc_test");
          const [completed, session] = body.batch;
          expect(completed?.event).toBe("cloud.turn.completed");
          expect(completed?.properties).toMatchObject({
            provider: "claudeAgent",
            model: "claude-fable-5-1",
            outcome: "completed",
            concurrentTurnsAtStart: 1,
            commandCounts: { test: 1, other: 0 },
            commandSeconds: { test: 2.5 },
            processCpuSeconds: 4.5,
            processPeakRssBytes: 450_000_000,
            modelRequests: 1,
            modelTokens: {
              "claude-fable-5-1-20261001": {
                input: 1_200,
                output: 340,
                cacheRead: 9_000,
                cacheWrite: 500,
              },
            },
            gitStoreOperations: { checkpoints: 0 },
            sessionStoreRows: 0,
            previewSeconds: 0,
            recoveryCount: 0,
            $process_person_profile: false,
            $geoip_disable: true,
          });
          const tailSeconds = (FINALIZE_GRACE_MS + ThreadRunner.IDLE_TAIL_MS) / 1000;
          expect(session?.event).toBe("cloud.machine.session");
          expect(session?.properties).toMatchObject({
            backend: "none",
            awakeSeconds: tailSeconds,
            idleTailSeconds: tailSeconds,
            cpuSeconds: 14.5,
            memoryPeakBytes: 450_000_000,
            diskUsedBytes: 4_000_000_000,
            egressBytes: 1_000_000,
            wakeToReadyMs: 0,
            wakeToFirstEventMs: 0,
            dependencyCacheHit: null,
            stopReason: "idle",
            turns: 1,
          });
          expect(completed?.distinct_id).toBe(session?.distinct_id);
          expect(completed?.distinct_id).toMatch(/^[0-9a-f]{16}$/);
          // No content, paths, command text or raw ids.
          const wire = JSON.stringify(body);
          for (const leak of [
            "secret-project",
            "pnpm test",
            "Hello!",
            "/tmp/thread",
            threadId,
            owner.userId,
            "native resume",
          ]) {
            expect(wire).not.toContain(leak);
          }
        }),
      { analytics: layerPostHog(sent) },
    );
  });
});
