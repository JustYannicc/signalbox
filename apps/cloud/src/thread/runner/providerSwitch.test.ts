import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerItem,
  type RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { CommandId, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import { historyCost } from "@t3tools/provider-core/server/handoffBudget";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  claude,
  connect,
  encodeProviderThread,
  freshDatabase,
  hello,
  launch,
  liveTurn,
  owner,
  personal,
  saveSession,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../runnerTesting.ts";
import type * as ThreadEngine from "../ThreadEngine.ts";

const codex = { instanceId: ProviderInstanceId.make("codex_hub"), model: "gpt-6.1-sol" };
const switchCommand = (id: string, modelSelection = codex) => ({
  type: "provider.switch" as const,
  commandId: CommandId.make(id),
  threadId,
  modelSelection,
});

const reportFor = (turn: RunnerTurn, replyText = "Codex remembers the conversation.") => {
  const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread, { replyText });
  const driver = turn.providerThread.driver;
  const driven = (item: RunnerItem) =>
    item.kind === "provider" ? { ...item, event: { ...item.event, driver } } : item;
  return {
    ...report,
    full: driven(report.full),
    terminal: driven(report.terminal),
    started: {
      ...report.started,
      preparationGeneration: turn.preparationGeneration,
      providerSession: {
        ...report.started.providerSession,
        id: ProviderSessionId.make(`session:${turn.runId}`),
        driver,
        providerInstanceId: turn.modelSelection.instanceId,
        model: turn.modelSelection.model,
      },
      providerThread: {
        ...report.started.providerThread,
        nativeThreadRef: {
          driver,
          nativeId: `${driver}-session-${turn.runOrdinal}`,
          strength: "strong" as const,
        },
      },
    },
  };
};

const completeFirst = (
  engine: ThreadEngine.ThreadEngine["Service"],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const machine = yield* connect(runner);
    const turn = yield* liveTurn(runner);
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    yield* runner.batch({
      generation: machine.generation,
      sequence: 1,
      items: [
        report.started,
        {
          kind: "drive.checkpoint",
          runId: turn.runId,
          start: null,
          commit: "a".repeat(40),
          files: [],
        },
        report.full,
        report.terminal,
      ],
    });
    yield* runner.ended(machine.generation, "test");
    return { machine, turn, report };
  });

describe("durable provider switch", () => {
  it.effect(
    "continues across providers and object reconnect without replacing history or native sessions",
    () =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        const pending = yield* withObject(filename, (engine, runner, context) =>
          Effect.gen(function* () {
            const first = yield* completeFirst(engine, runner);
            yield* saveSession(context, "claude-session-1");
            const before = yield* snapshot(engine);
            const command = switchCommand("switch-to-codex");
            yield* engine.dispatch(owner, command, personal);
            const selected = yield* snapshot(engine);
            expect(selected.projection.thread.modelSelection).toEqual(codex);
            expect(selected.projection.runs).toEqual(before.projection.runs);
            expect(selected.projection.contextHandoffs).toEqual([]);
            expect(selected.projection.checkpoints).toEqual(before.projection.checkpoints);
            yield* send(engine, 2, "Carry on with the same work.");
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            expect(turn).toMatchObject({
              providerTurnOrdinal: 1,
              providerThread: { nativeThreadRef: null },
            });
            expect(turn.providerThread.id).not.toBe(first.turn.providerThread.id);
            expect(turn.message.text).toContain("]\nHi\n\n[Historical assistant;");
            expect(turn.message.text).toContain("]\nHello!\n\n");
            expect(turn.message.text).toContain("User message:\nCarry on with the same work.");
            const prepared = yield* snapshot(engine);
            expect(prepared.projection.contextHandoffs).toHaveLength(1);
            expect(prepared.projection.contextHandoffs[0]).toMatchObject({
              targetRunId: turn.runId,
              delivery: { status: "pending" },
            });
            expect((yield* liveTurn(runner)).message.text).toBe(turn.message.text);
            expect((yield* snapshot(engine)).head).toBe(prepared.head);
            return { ...first, machine, turn, before, prepared, command };
          }),
        );
        yield* withObject(filename, (engine, runner) =>
          Effect.gen(function* () {
            const welcome = yield* runner.hello({
              ...hello(pending.machine.generation, pending.machine.token),
              takenRunIds: [],
            });
            expect(welcome._tag).toBe("welcome");
            const turn = yield* liveTurn(runner);
            expect(turn.runId).toBe(pending.turn.runId);
            expect(turn.message.text).toBe(pending.turn.message.text);
            yield* engine.dispatch(owner, pending.command, { place: null, pools: null });
            expect((yield* snapshot(engine)).projection.contextHandoffs).toHaveLength(1);
            const report = reportFor(turn);
            yield* runner.batch({
              generation: pending.machine.generation,
              sequence: 1,
              items: [
                report.started,
                {
                  kind: "provider",
                  runId: turn.runId,
                  event: {
                    type: "provider_thread.updated",
                    providerThread: encodeProviderThread({
                      ...report.started.providerThread,
                      handoffIds: [],
                      firstRunOrdinal: 1,
                      lastRunOrdinal: 1,
                    }),
                  },
                },
                report.full,
                report.terminal,
              ],
            });
            // The old harness's late session reports cannot change either durable provider thread.
            const settled = yield* snapshot(engine);
            yield* runner.batch({
              generation: pending.machine.generation,
              sequence: 2,
              items: [
                pending.report.started,
                turnReport(pending.report.started.runId, 1, pending.report.started.providerThread, {
                  replyText: "Stale text must not replace the source conversation.",
                }).full,
                {
                  kind: "provider",
                  runId: turn.runId,
                  event: {
                    type: "provider_thread.updated",
                    providerThread: encodeProviderThread(pending.report.started.providerThread),
                  },
                },
              ],
            });
            const after = yield* snapshot(engine);
            expect(after.projection.messages).toEqual(settled.projection.messages);
            expect(after.projection.providerThreads).toEqual(settled.projection.providerThreads);
            expect(after.projection.providerThreads).toHaveLength(2);
            expect(after.projection.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(
              "claude-session-1",
            );
            expect(after.projection.providerThreads[1]?.nativeThreadRef?.nativeId).toBe(
              "codex-session-2",
            );
            expect(after.projection.providerThreads[1]).toMatchObject({
              firstRunOrdinal: 2,
              lastRunOrdinal: 2,
              handoffIds: [after.projection.contextHandoffs[0]?.id],
            });
            expect(after.projection.contextHandoffs[0]?.delivery?.status).toBe("inline");
            expect(
              after.projection.turnItems.filter((item) => item.type === "handoff"),
            ).toHaveLength(1);
            expect(after.projection.checkpoints).toEqual(pending.before.projection.checkpoints);
            expect(
              after.projection.messages.slice(0, pending.before.projection.messages.length),
            ).toEqual(pending.before.projection.messages);
            expect(
              (yield* runner.batch({
                generation: pending.machine.generation - 1,
                sequence: 3,
                items: [pending.report.started],
              }))._tag,
            ).toBe("stale");
            yield* engine.dispatch(owner, switchCommand("switch-back", claude), personal);
            yield* send(engine, 3, "Back to Claude.");
            const back = yield* liveTurn(runner);
            expect(back.providerThread.nativeThreadRef).toBeNull();
            expect(back.providerThread.id).not.toBe(pending.report.started.providerThread.id);
            expect(back.message.text).toContain("Codex remembers the conversation.");
            expect((yield* snapshot(engine)).projection.providerThreads).toHaveLength(3);
          }),
        );
      }),
  );

  it.effect.each(["failed", "cancelled"] as const)(
    "retries a %s preparation with one handoff and fences the previous attempt",
    (ending) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* completeFirst(engine, runner);
          yield* engine.dispatch(owner, switchCommand("switch-before-retry"), personal);
          yield* send(engine, 2, "Continue after the switch.");
          const plan = yield* runner.reconcile;
          if (plan.ensure === null) throw new Error("No machine requested");
          const { generation, token } = plan.ensure;
          yield* runner.hello({
            ...hello(generation, token),
            protocolVersion: RUNNER_PROTOCOL_VERSION,
          });
          const turn = yield* liveTurn(runner);
          if (turn.preparationGeneration === undefined)
            throw new Error("No preparation generation");
          const target = { runId: turn.runId, preparationGeneration: turn.preparationGeneration };
          if (ending === "cancelled") {
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("stop-handoff"),
                threadId,
                runId: turn.runId,
                holdQueue: true,
              },
              personal,
            );
          }
          yield* runner.batch({
            generation,
            sequence: 1,
            items: [
              {
                kind: ending === "failed" ? "preparation.failed" : "preparation.cancelled",
                ...target,
              },
            ],
          });
          const before = yield* snapshot(engine);
          const retry = {
            type: "prepared-run.retry" as const,
            commandId: CommandId.make("retry-handoff"),
            threadId,
            ...target,
          };
          yield* engine.dispatch(owner, retry, personal);
          yield* engine.dispatch(owner, retry, personal);
          const again = yield* liveTurn(runner);
          expect(again.runId).toBe(turn.runId);
          expect(again.preparationGeneration).toBe(turn.preparationGeneration + 1);
          expect(again.message.text).toBe(turn.message.text);
          const report = reportFor(again);
          yield* runner.batch({
            generation,
            sequence: 2,
            items: [{ ...report.started, preparationGeneration: turn.preparationGeneration }],
          });
          expect((yield* snapshot(engine)).projection.runs[1]?.startedAt).toBeNull();
          yield* runner.batch({
            generation,
            sequence: 3,
            items: [
              {
                kind: "preparation.ready",
                runId: again.runId,
                preparationGeneration: again.preparationGeneration!,
              },
            ],
          });
          yield* runner.batch({
            generation,
            sequence: 4,
            items: [report.started, report.started, report.full, report.terminal],
          });
          const after = yield* snapshot(engine);
          expect(after.projection.runs).toHaveLength(2);
          expect(after.projection.runs[1]?.status).toBe("completed");
          expect(after.projection.contextHandoffs).toHaveLength(1);
          expect(after.projection.contextHandoffs[0]?.id).toBe(
            before.projection.contextHandoffs[0]?.id,
          );
          expect(after.projection.turnItems.filter((item) => item.type === "handoff")).toHaveLength(
            1,
          );
          expect((yield* runner.work).turn).toBeNull();
        }),
      ),
  );

  it.effect(
    "bounds imported history while retaining complete source items and recovery instructions",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine, "large-history", personal, { text: "日".repeat(25_000) });
          const first = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread, {
            replyText: "Ready.",
          });
          yield* runner.batch({
            generation: first.generation,
            sequence: 1,
            items: [report.started, report.full, report.terminal],
          });
          yield* engine.dispatch(owner, switchCommand("switch-large"), personal);
          yield* send(engine, 2, "Continue.");
          const next = yield* liveTurn(runner);
          const { projection } = yield* snapshot(engine);
          const history = projection.contextHandoffs[0]?.history;
          if (history === undefined) throw new Error("No durable handoff history");
          expect(historyCost(history.messages, history.coverage)).toBeLessThanOrEqual(16_000);
          expect(history.omittedItems).toBeGreaterThan(0);
          expect(next.message.text).toContain("t3_thread_read");
          expect(next.message.text).toContain("Ready.");
          expect(projection.messages[0]?.text).toBe("日".repeat(25_000));
        }),
      ),
  );
});
