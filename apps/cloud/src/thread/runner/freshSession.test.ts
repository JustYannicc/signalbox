import {
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderTurnId,
  RunAttemptId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  connect,
  claudeDriver,
  encodeTurnItem,
  freshDatabase,
  launch,
  liveTurn,
  now,
  owner,
  personal,
  saveSession,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../runnerTesting.ts";

describe("fresh-session handoff delivery", () => {
  it.effect.each([
    { ending: "failed", attempt: "none", type: "assistant_message" },
    { ending: "interrupted", attempt: "none", type: "assistant_message" },
    { ending: "interrupted", attempt: "sync", type: "assistant_message" },
    { ending: "interrupted", attempt: "sync", type: "command_execution" },
    { ending: "interrupted", attempt: "active", type: "assistant_message" },
    { ending: "interrupted", attempt: "active", type: "command_execution" },
  ] as const)(
    "checks handoff receipt after $ending with $attempt $type output",
    ({ ending, attempt, type }) =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const first = yield* liveTurn(runner);
          const firstReport = turnReport(first.runId, first.runOrdinal, first.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [firstReport.started, firstReport.full, firstReport.terminal],
          });
          yield* send(engine, 2, "Finish the original work.");
          const second = yield* liveTurn(runner);
          const secondReport = turnReport(second.runId, second.runOrdinal, second.providerThread);
          const started = {
            ...secondReport.started,
            providerThread: {
              ...secondReport.started.providerThread,
              nativeThreadRef: {
                ...secondReport.started.providerThread.nativeThreadRef,
                nativeId: "handoff-session",
              },
            },
          };
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [
              started,
              {
                kind: "provider",
                runId: second.runId,
                event: {
                  type: "provider_turn.updated",
                  driver: claudeDriver,
                  providerTurn: {
                    id: `claude-turn:${second.runId}`,
                    providerThreadId: second.providerThread.id,
                    nodeId: second.rootNodeId,
                    runAttemptId: second.attemptId,
                    nativeTurnRef: null,
                    ordinal: 1,
                    status: "running",
                    startedAt: null,
                    completedAt: null,
                  },
                },
              },
            ],
          });
          expect(
            (yield* snapshot(engine)).projection.providerTurns.some(
              (turn) => turn.runAttemptId === second.attemptId,
            ),
          ).toBe(true);
          if (attempt !== "none") {
            const providerTurnId = ProviderTurnId.make(
              `${attempt === "sync" ? "sync" : "claude"}-turn:${second.runId}`,
            );
            yield* runner.batch({
              generation: machine.generation,
              sequence: 3,
              items: [
                {
                  kind: "provider",
                  runId: second.runId,
                  event: {
                    type: "provider_turn.updated",
                    driver: claudeDriver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: second.providerThread.id,
                      nodeId: second.rootNodeId,
                      runAttemptId:
                        attempt === "sync"
                          ? RunAttemptId.make(`${second.attemptId}:sync:1`)
                          : second.attemptId,
                      nativeTurnRef: null,
                      ordinal: attempt === "sync" ? 1101 : 1,
                      status: "running",
                      startedAt: null,
                      completedAt: null,
                    },
                  },
                },
                {
                  kind: "provider",
                  runId: second.runId,
                  event: {
                    type: "turn_item.updated",
                    driver: claudeDriver,
                    turnItem: encodeTurnItem({
                      id: TurnItemId.make(`output:${second.runId}`),
                      threadId,
                      runId: second.runId,
                      nodeId: second.rootNodeId,
                      providerThreadId: second.providerThread.id,
                      providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 7,
                      status: "completed",
                      title: null,
                      startedAt: now,
                      completedAt: now,
                      updatedAt: now,
                      ...(type === "assistant_message"
                        ? {
                            type,
                            messageId: MessageId.make(`reply:${second.runId}`),
                            text: "Working on it.",
                            streaming: false,
                          }
                        : { type, input: "git status", output: "On branch main", exitCode: 0 }),
                    }),
                  },
                },
              ],
            });
            const before = yield* snapshot(engine);
            expect(before.projection.runs[1]?.activeAttemptId).toBe(second.attemptId);
            expect(
              before.projection.turnItems.find(
                (item) => item.runId === second.runId && item.type === type,
              )?.providerTurnId,
            ).toBe(providerTurnId);
          }
          yield* saveSession(context, "handoff-session");
          if (ending === "failed") {
            yield* runner.batch({
              generation: machine.generation,
              sequence: 3,
              items: [
                {
                  kind: "turn.failed",
                  runId: second.runId,
                  message: "Provider refused the prompt.",
                },
              ],
            });
          } else {
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("interrupt-before-prompt"),
                threadId,
                runId: second.runId,
                holdQueue: true,
              },
              personal,
            );
          }
          yield* send(engine, 3, "Try again.");
          yield* send(engine, 3, "Try again.");
          const retried = yield* liveTurn(runner);
          if (attempt === "active") {
            expect(retried.providerThread.nativeThreadRef?.nativeId).toBe("handoff-session");
            expect(retried.message.text).toBe("Try again.");
          } else {
            expect(retried.providerThread.nativeThreadRef).toBeNull();
            expect(retried.message.text).toContain("Finish the original work.");
            expect(retried.message.text).toContain("Hello!");
            expect(retried.message.text.endsWith("User message:\nTry again.")).toBe(true);
          }
          const after = yield* snapshot(engine);
          expect(after.projection.runs).toHaveLength(3);
          expect(after.projection.contextHandoffs).toHaveLength(attempt === "active" ? 1 : 2);
          expect((yield* liveTurn(runner)).message.text).toBe(retried.message.text);
          expect((yield* snapshot(engine)).head).toBe(after.head);
        }),
      ),
  );

  it.effect.each([true, false])(
    "requires a handoff budget only when fresh, native session saved: %s",
    (saved) =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const first = yield* liveTurn(runner);
          const report = turnReport(first.runId, first.runOrdinal, first.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.full, report.terminal],
          });
          if (saved) yield* saveSession(context, "claude-session-1");
          const text = "x".repeat(100_000);
          yield* send(engine, 2, text);
          const work = yield* runner.work;
          if (saved) {
            expect(work.turn?.providerThread.nativeThreadRef?.nativeId).toBe("claude-session-1");
            expect(work.turn?.message.text).toBe(text);
            expect(work.turn?.freshSessionText).toBeUndefined();
          } else {
            expect(work.turn).toBeNull();
            const after = yield* snapshot(engine);
            expect(after.projection.runs[1]?.status).toBe("failed");
            expect(
              after.projection.turnItems.some(
                (item) =>
                  item.type === "error" &&
                  item.failure.message.includes("There isn't enough context space"),
              ),
            ).toBe(true);
          }
          const after = yield* snapshot(engine);
          expect(after.projection.contextHandoffs).toEqual([]);
          expect(after.projection.runs[1]?.contextHandoffId).toBeNull();
        }),
      ),
  );

  it.effect("records a resume fallback only when the runner actually starts a new session", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const first = yield* liveTurn(runner);
        const report = turnReport(first.runId, first.runOrdinal, first.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        yield* saveSession(context, "claude-session-1");
        yield* send(engine, 2, "Continue.");
        const turn = yield* liveTurn(runner);
        expect(turn.freshSessionText).toContain("Hello!");
        expect((yield* snapshot(engine)).projection.contextHandoffs).toEqual([]);
        const started = turnReport(turn.runId, turn.runOrdinal, turn.providerThread).started;
        const fallback = {
          ...started,
          providerThread: {
            ...started.providerThread,
            nativeThreadRef: {
              ...started.providerThread.nativeThreadRef,
              nativeId: "fallback-session",
            },
          },
        };
        yield* runner.batch({
          generation: machine.generation,
          sequence: 2,
          items: [fallback, fallback],
        });
        const after = yield* snapshot(engine);
        expect(after.projection.contextHandoffs).toHaveLength(1);
        const handoff = after.projection.contextHandoffs[0];
        expect(handoff?.delivery).toMatchObject({
          status: "inline",
          nativeThreadId: "fallback-session",
        });
        expect(handoff?.summaryText).toContain("Hello!");
        expect(after.projection.runs[1]?.contextHandoffId).toBe(handoff?.id);
        expect(after.projection.turnItems.filter((item) => item.type === "handoff")).toHaveLength(
          1,
        );
      }),
    ),
  );

  it.effect("keeps normal native-resume fallbacks out of durable history", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const first = yield* liveTurn(runner);
        const report = turnReport(first.runId, first.runOrdinal, first.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        yield* saveSession(context, "claude-session-1");
        for (const ordinal of [2, 3]) {
          yield* send(engine, ordinal, "Continue.");
          const turn = yield* liveTurn(runner);
          expect(turn.message.text).toBe("Continue.");
          expect(turn.providerThread.nativeThreadRef?.nativeId).toBe("claude-session-1");
          expect(turn.freshSessionText).toContain("Hello!");
          expect((yield* snapshot(engine)).projection.contextHandoffs).toEqual([]);
          const next = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: ordinal,
            items: [next.started, next.full, next.terminal],
          });
        }
        const after = yield* snapshot(engine);
        expect(after.projection.runs.every((run) => run.contextHandoffId === null)).toBe(true);
        expect(after.projection.contextHandoffs).toEqual([]);
        expect(after.projection.turnItems.filter((item) => item.type === "handoff")).toEqual([]);
      }),
    ),
  );

  it.effect("does not retry a superseded fallback after an interruption before output", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const first = yield* liveTurn(runner);
        const report = turnReport(first.runId, first.runOrdinal, first.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        yield* saveSession(context, "claude-session-1");
        yield* send(engine, 2, "Continue.");
        const second = yield* liveTurn(runner);
        // Reproduce fallback rows written by the previous implementation.
        yield* engine.apply((projection, ctx) => {
          const run = projection?.runs.find((candidate) => candidate.id === second.runId);
          if (run === undefined) throw new Error("Expected the active run");
          const handoffId = ContextHandoffId.make(`legacy-handoff:${second.runId}`);
          const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
            {
              id: EventId.make("legacy-handoff"),
              threadId,
              runId: second.runId,
              type: "context-handoff.updated",
              occurredAt: ctx.now,
              payload: {
                id: handoffId,
                threadId,
                targetRunId: second.runId,
                fromProviderThreadIds: [first.providerThread.id],
                toProviderThreadId: second.providerThread.id,
                coveredRunOrdinals: { from: 1, to: 1 },
                strategy: "full_thread_summary",
                status: "ready",
                summaryMessageId: null,
                summaryText: "User: Hi\nAssistant: Hello!",
                delivery: {
                  nativeThreadId: "claude-session-1",
                  status: "pending",
                  itemIds: [],
                },
                createdByProviderInstanceId: run.providerInstanceId,
                createdAt: ctx.now,
                updatedAt: ctx.now,
              },
            },
            {
              id: EventId.make("legacy-handoff-run"),
              threadId,
              runId: second.runId,
              type: "run.updated",
              occurredAt: ctx.now,
              payload: { ...run, contextHandoffId: handoffId },
            },
          ];
          return Effect.succeed({ events, result: undefined });
        });
        const started = turnReport(second.runId, second.runOrdinal, second.providerThread).started;
        yield* runner.batch({ generation: machine.generation, sequence: 2, items: [started] });
        expect((yield* snapshot(engine)).projection.contextHandoffs[0]?.status).toBe("superseded");
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("interrupt-native-resume"),
            threadId,
            runId: second.runId,
            holdQueue: true,
          },
          personal,
        );
        yield* send(engine, 3, "Try again.");
        const retried = yield* liveTurn(runner);
        expect(retried.providerThread.nativeThreadRef?.nativeId).toBe("claude-session-1");
        expect(retried.message.text).toBe("Try again.");
        expect((yield* snapshot(engine)).projection.contextHandoffs).toHaveLength(1);
      }),
    ),
  );
});
