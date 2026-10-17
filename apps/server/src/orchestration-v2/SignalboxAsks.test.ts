import { expect, it } from "@effect/vitest";
import { CommandId, MessageId } from "@t3tools/contracts";
import { applyAskCommand } from "@t3tools/shared/signalboxAsks";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { layer, threadId, create, raise, answer } from "./SignalboxAsks.testkit.ts";

it.effect(
  "keeps work active, queues a partial answer and restores pending rounds from events",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      yield* orchestrator.dispatch(raise);
      expect((yield* orchestrator.getThreadProjection(threadId)).runs).toEqual([]);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue"),
        threadId,
        messageId: MessageId.make("continue"),
        text: "Keep working independently",
        attachments: [],
        createdBy: "agent",
        creationSource: "mcp",
        dispatchMode: { type: "start_immediately" },
      });
      const result = yield* orchestrator.dispatch(answer());
      expect(
        result.storedEvents.some(({ event }) => event.type === "thread.metadata-updated"),
      ).toBe(true);
      expect(result.storedEvents.some(({ event }) => event.type === "message.updated")).toBe(true);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      expect(projection.runs.map((run) => run.status)).toEqual(["starting", "queued"]);
      expect(projection.thread.asks?.[0]?.rounds[1]?.questionIds).toEqual(["b"]);
      expect(projection.messages.at(-1)?.text).toContain("Why: Need your preference");
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      expect((yield* maintenance.rebuild).valid).toBe(true);
      expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks).toEqual(
        projection.thread.asks,
      );
      expect((yield* orchestrator.getThreadShell(threadId))?.asks).toEqual(projection.thread.asks);
      const replay = yield* orchestrator.dispatch(answer());
      expect(replay.sequence).toBe(result.sequence);
      expect((yield* orchestrator.getThreadProjection(threadId)).messages).toHaveLength(2);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId,
      });
      const archived = (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0];
      expect(archived?.status).toBe("archived");
      expect(archived?.rounds[0]?.answers).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "commits answer, message and provider outbox together, rolling back if enqueue fails",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      yield* orchestrator.dispatch(raise);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_ask_outbox BEFORE INSERT ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(FAIL, 'outbox unavailable'); END`;
      const failed = yield* Effect.exit(orchestrator.dispatch(answer()));
      expect(Exit.isFailure(failed)).toBe(true);
      const unchanged = yield* orchestrator.getThreadProjection(threadId);
      expect(unchanged.thread.asks?.[0]?.rounds).toHaveLength(1);
      expect(unchanged.messages).toEqual([]);
      yield* sql`DROP TRIGGER reject_ask_outbox`;
      const command = { ...answer(), commandId: CommandId.make("answer:retry") };
      yield* orchestrator.dispatch(command);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      expect((yield* outbox.listByCommandId(command.commandId)).length).toBeGreaterThan(0);
      expect(
        (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0]?.rounds,
      ).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "routes automation answers through the engine and accepts its sync without applying twice",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      yield* orchestrator.dispatch({
        ...raise,
        ask: { ...raise.ask, source: { kind: "automation", runId: "run", stepKey: "gate" } },
      });
      const threads = yield* ThreadManagement.ThreadManagementService;
      let calls = 0;
      const mockEngine = Layer.mock(WorkflowEngine.WorkflowEngine)({
        validate: () => ({ ok: false, diagnostics: [] }),
        answerSignalboxAsk: (command, ask) =>
          Effect.gen(function* () {
            calls++;
            const applied = applyAskCommand(
              [ask],
              command,
              DateTime.formatIso(yield* DateTime.now),
            );
            if (!applied.ok) return yield* Effect.die(applied.error);
            yield* threads
              .dispatch({
                type: "thread.ask.sync",
                commandId: CommandId.make("engine-sync"),
                threadId,
                ask: applied.asks[0]!,
              })
              .pipe(Effect.orDie);
          }),
      });
      const result = yield* threads.dispatch(answer()).pipe(Effect.provide(mockEngine));
      expect(calls).toBe(1);
      expect(result.sequence).toBe(yield* orchestrator.getThreadEventSequence(threadId));
      const projection = yield* orchestrator.getThreadProjection(threadId);
      expect(projection.thread.asks?.[0]?.rounds).toHaveLength(2);
      expect(projection.messages).toEqual([]);
    }).pipe(Effect.provide(ThreadManagement.layer.pipe(Layer.provideMerge(layer)))),
);
