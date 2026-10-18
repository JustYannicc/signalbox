import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  connect,
  claudeDriver,
  freshDatabase,
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
import { prepareFreshSession } from "./freshSession.ts";

describe("fresh-session handoff delivery", () => {
  it.effect.each(["failed", "interrupted"] as const)(
    "retries a handoff whose session loaded but whose prompt was %s before provider acceptance",
    (ending) =>
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
                nativeId: "session-with-no-prompt",
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
          yield* saveSession(context, "session-with-no-prompt");
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
          expect(retried.providerThread.nativeThreadRef).toBeNull();
          expect(retried.message.text).toContain("Finish the original work.");
          expect(retried.message.text).toContain("Hello!");
          expect(retried.message.text.endsWith("User message:\nTry again.")).toBe(true);
          const after = yield* snapshot(engine);
          expect(after.projection.runs).toHaveLength(3);
          expect(after.projection.contextHandoffs).toHaveLength(2);
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
          if (projection === null) throw new Error("Expected a thread");
          const prepared = prepareFreshSession(projection, second, ctx, 16_000, true);
          if (prepared._tag !== "ready") throw new Error("Expected a handoff");
          const events = prepared.events.map((event): OrchestrationV2DomainEvent =>
            event.type === "context-handoff.updated"
              ? {
                  ...event,
                  payload: {
                    ...event.payload,
                    delivery: {
                      nativeThreadId: "claude-session-1",
                      status: "pending",
                      itemIds: [],
                    },
                  },
                }
              : event,
          );
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
