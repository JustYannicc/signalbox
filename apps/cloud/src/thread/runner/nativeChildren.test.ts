import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  CommandId,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  claudeDriver,
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  snapshot,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";
import type { NativeChildBatchInput } from "./nativeChildBatch.ts";

const encodeThread = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2AppThread));
const encodeMessage = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ConversationMessage));
const encodeSubagent = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2Subagent));
const encodeTurnItem = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2TurnItem));

describe("provider-native child history", () => {
  it.effect(
    "survives split attestation, relay retries and eviction without starting a child run",
    () =>
      Effect.gen(function* () {
        const parentDatabase = freshDatabase();
        const childDatabase = freshDatabase();
        const childThreadId = ThreadId.make("native-child");
        let failAfterSave = true;
        const relayed: Array<NativeChildBatchInput> = [];
        const relay = {
          save: (input: NativeChildBatchInput) =>
            Effect.andThen(
              Effect.sync(() => relayed.push(input)),
              Effect.andThen(
                withObject(childDatabase, (engine) => engine.recordNativeChildBatch(input)).pipe(
                  Effect.orDie,
                ),
                Effect.suspend(() => {
                  if (!failAfterSave) return Effect.void;
                  failAfterSave = false;
                  return Effect.die("relay disconnected after saving child");
                }),
              ),
            ),
        };
        const options = { nativeChildRelay: relay };
        const first = yield* withObject(
          parentDatabase,
          (engine, runner) =>
            Effect.gen(function* () {
              yield* launch(engine);
              const machine = yield* connect(runner);
              const turn = yield* liveTurn(runner);
              const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
              yield* runner.batch({
                generation: machine.generation,
                sequence: 1,
                items: [report.started],
              });
              const parent = (yield* snapshot(engine)).projection;
              const now = parent.thread.updatedAt;
              const subagentId = NodeId.make("native-child-task");
              const childProviderId = ProviderThreadId.make("native-child-provider");
              const appThread: typeof OrchestrationV2AppThread.Type = {
                ...parent.thread,
                id: childThreadId,
                createdBy: "agent",
                creationSource: "provider",
                title: "Native child",
                activeProviderThreadId: childProviderId,
                lineage: {
                  ...parent.thread.lineage,
                  parentThreadId: parent.thread.id,
                  relationshipToParent: "subagent",
                },
                forkedFrom: { type: "node", nodeId: subagentId },
              };
              const attestation: typeof OrchestrationV2Subagent.Type = {
                id: subagentId,
                threadId: parent.thread.id,
                runId: turn.runId,
                parentNodeId: parent.runs[0]!.rootNodeId!,
                origin: "provider_native",
                createdBy: "agent",
                driver: claudeDriver,
                providerInstanceId: parent.thread.providerInstanceId,
                providerThreadId: childProviderId,
                childThreadId,
                nativeTaskRef: null,
                prompt: "Answer briefly",
                title: "Native child",
                model: parent.thread.modelSelection.model,
                status: "running",
                result: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
              };
              const message: typeof OrchestrationV2ConversationMessage.Type = {
                createdBy: "agent",
                creationSource: "provider",
                id: MessageId.make("native-child-answer"),
                threadId: childThreadId,
                runId: null,
                nodeId: null,
                role: "assistant",
                text: "Partial answer",
                attachments: [],
                streaming: true,
                createdAt: now,
                updatedAt: now,
              };
              const transcript: typeof OrchestrationV2TurnItem.Type = {
                id: TurnItemId.make("native-child-answer-item"),
                threadId: childThreadId,
                runId: null,
                nodeId: null,
                providerThreadId: childProviderId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 7,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "assistant_message",
                messageId: message.id,
                text: "NATIVE_CHILD_DURABLE",
                streaming: false,
              };
              const item = (event: Record<string, unknown>): RunnerItem => ({
                kind: "provider",
                runId: turn.runId,
                event: { driver: claudeDriver, ...event },
              });
              // Child rows can precede the parent card in a different batch.
              yield* runner.batch({
                generation: machine.generation,
                sequence: 2,
                items: [
                  item({
                    type: "app_thread.created",
                    appThread: yield* encodeThread(appThread),
                  }),
                  item({
                    type: "message.updated",
                    message: yield* encodeMessage(message),
                  }),
                ],
              });
              return {
                generation: machine.generation,
                attestation: item({
                  type: "subagent.updated",
                  subagent: yield* encodeSubagent(attestation),
                }),
                finalMessage: item({
                  type: "message.updated",
                  message: yield* encodeMessage({
                    ...message,
                    text: "NATIVE_CHILD_DURABLE",
                    streaming: false,
                  }),
                }),
                transcript: item({
                  type: "turn_item.updated",
                  turnItem: yield* encodeTurnItem(transcript),
                }),
              };
            }),
          options,
        );

        // A new object must recover the buffered creation before accepting the card.
        yield* withObject(
          parentDatabase,
          (engine, runner) =>
            Effect.gen(function* () {
              const batch = {
                generation: first.generation,
                sequence: 3,
                items: [first.attestation],
              };
              expect(Exit.isFailure(yield* Effect.exit(runner.batch(batch)))).toBe(true);
              const saved = yield* withObject(childDatabase, (child) => snapshot(child));
              expect(saved.projection.messages.map((message) => message.text)).toEqual([
                "Partial answer",
              ]);
              expect(yield* runner.batch(batch)).toEqual({ _tag: "ack", sequence: 3 });
              expect((yield* withObject(childDatabase, (child) => snapshot(child))).head).toBe(
                saved.head,
              );
              expect(
                (yield* snapshot(engine)).projection.messages.every(
                  (message) => message.threadId !== childThreadId,
                ),
              ).toBe(true);
            }),
          options,
        );

        // Creation metadata must remain available for later transcript-only batches.
        yield* withObject(
          parentDatabase,
          (_engine, runner) =>
            runner.batch({
              generation: first.generation,
              sequence: 4,
              items: [first.finalMessage, first.transcript],
            }),
          options,
        );
        yield* withObject(
          childDatabase,
          (engine) =>
            Effect.gen(function* () {
              const child = yield* snapshot(engine);
              expect(child.projection.thread.id).toBe(childThreadId);
              expect(child.projection.messages.map((message) => message.text)).toEqual([
                "NATIVE_CHILD_DURABLE",
              ]);
              expect(child.projection.runs).toEqual([]);
              expect(child.projection.visibleTurnItems.map(({ item }) => item)).toMatchObject([
                { type: "assistant_message", text: "NATIVE_CHILD_DURABLE", runId: null },
              ]);
              const lastBatch = relayed.at(-1)!;
              expect(
                Exit.isFailure(
                  yield* Effect.exit(
                    engine.recordNativeChildBatch({
                      ...lastBatch,
                      sequence: lastBatch.sequence + 100,
                      owner: { ...lastBatch.owner, userId: "another-user" },
                    }),
                  ),
                ),
              ).toBe(true);
              expect((yield* snapshot(engine)).head).toBe(child.head);
              expect(yield* engine.hasTurnWork).toBe(false);
              const result = yield* Effect.exit(
                engine.dispatch(
                  owner,
                  {
                    type: "message.dispatch",
                    commandId: CommandId.make("native-child-send"),
                    createdBy: "user",
                    creationSource: "web",
                    threadId: childThreadId,
                    messageId: MessageId.make("native-child-send"),
                    text: "Do not start a separate run",
                    attachments: [],
                    dispatchMode: { type: "start_immediately" },
                  },
                  personal,
                ),
              );
              expect(Exit.isFailure(result)).toBe(true);
              expect((yield* snapshot(engine)).projection.runs).toEqual([]);
            }),
          options,
        );
      }),
  );
});
