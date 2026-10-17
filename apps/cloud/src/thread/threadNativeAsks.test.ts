import {
  CommandId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { unstampedEventId } from "./threadEvents.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runner/runnerTestKit.ts";

describe("cloud native asks", () => {
  it.effect.each([
    { secret: false, name: "resolves a complete public answer through the live callback" },
    { secret: true, name: "queues the public answer without resolving a mixed secret callback" },
  ])("$name", ({ secret }) =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine, "launch", personal, undefined, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        });
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started],
        });
        const requestId = RuntimeRequestId.make("native-question");
        const providerTurnId = ProviderTurnId.make(`claude-turn:${turn.runId}`);
        yield* engine.apply((_projection, ctx) =>
          Effect.succeed({
            result: undefined,
            events: [
              {
                id: unstampedEventId,
                threadId,
                occurredAt: ctx.now,
                type: "provider-turn.updated",
                payload: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: ctx.now,
                  completedAt: null,
                },
              },
              {
                id: unstampedEventId,
                threadId,
                occurredAt: ctx.now,
                type: "runtime-request.updated",
                payload: {
                  id: requestId,
                  nodeId: turn.rootNodeId,
                  providerTurnId,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: {
                    type: "live",
                    providerSessionId: ProviderSessionId.make("session-1"),
                  },
                  createdAt: ctx.now,
                  resolvedAt: null,
                },
              },
              {
                id: unstampedEventId,
                threadId,
                occurredAt: ctx.now,
                type: "turn-item.updated",
                payload: {
                  id: TurnItemId.make("native-question-item"),
                  threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "waiting",
                  title: "Native input",
                  startedAt: ctx.now,
                  completedAt: null,
                  updatedAt: ctx.now,
                  type: "user_input_request",
                  requestId,
                  questions: [
                    { id: "public", header: "City", question: "Which city?", options: [] },
                    ...(secret
                      ? [
                          {
                            id: "secret",
                            header: "Secret",
                            question: "Private token",
                            options: [],
                            native: { isSecret: true },
                          },
                        ]
                      : []),
                  ],
                },
              },
            ],
          }),
        );
        yield* engine.dispatch(
          owner,
          {
            type: "thread.ask.answer",
            commandId: CommandId.make("answer-native"),
            threadId,
            askId: `native:${requestId}`,
            round: 1,
            answers: [{ questionId: "public", value: "Zurich" }],
            deferredQuestionIds: [],
            answeredBy: { kind: "person", personId: owner.userId },
          },
          personal,
        );
        const { projection } = yield* snapshot(engine);
        const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
        expect(request?.status).toBe(secret ? "pending" : "resolved");
        expect(request?.answers).toEqual(secret ? undefined : { public: "Zurich" });
        expect(projection.thread.asks?.[0]?.status).toBe("answered");
        expect(projection.thread.asks?.[0]?.questions.map((question) => question.id)).toEqual([
          "public",
        ]);
        expect(JSON.stringify(projection.thread.asks)).not.toContain("Private token");
        const replies = projection.messages.filter((message) => message.text.includes("Zurich"));
        expect(replies).toHaveLength(secret ? 1 : 0);
        expect(projection.runs.map((run) => run.status)).toEqual(
          secret ? ["running", "queued"] : ["running"],
        );
      }),
    ),
  );
});
