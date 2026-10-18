import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Subagent,
  ProjectId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadStore from "../ThreadStore.ts";
import {
  TurnReports,
  claudeDriver,
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  snapshot,
  turnReport,
  withObject,
} from "../ThreadTestKit.ts";
import type { NativeChildBatchInput } from "../NativeChildProtocol.ts";

const encodeThread = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2AppThread));
const encodeMessage = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ConversationMessage));
const encodeSubagent = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2Subagent));

describe("native child mismatch relay", () => {
  it.effect("warns and acknowledges mismatched children while saving valid siblings", () => {
    const parentDatabase = freshDatabase();
    const ownerMismatchDatabase = freshDatabase();
    const projectMismatchDatabase = freshDatabase();
    const validSiblingDatabase = freshDatabase();
    const ownerMismatchId = ThreadId.make("native-child-owner-mismatch");
    const projectMismatchId = ThreadId.make("native-child-project-mismatch");
    const validSiblingId = ThreadId.make("native-child-valid-sibling");
    const childDatabases = new Map<ThreadId, string>([
      [ownerMismatchId, ownerMismatchDatabase],
      [projectMismatchId, projectMismatchDatabase],
      [validSiblingId, validSiblingDatabase],
    ]);
    const options = {
      nativeChildRelay: {
        save: (input: NativeChildBatchInput) => {
          const database = childDatabases.get(input.childThreadId);
          if (database === undefined) return Effect.die("Unexpected native child id.");
          return withObject(database, (engine) => engine.recordNativeChildBatch(input)).pipe(
            Effect.orDie,
          );
        },
      },
    };

    return withObject(
      parentDatabase,
      (engine, runner, context) =>
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
          const storedOwner = yield* Context.get(context, ThreadStore.ThreadStore).owner;
          if (storedOwner === null) throw new Error("expected the launched thread owner");
          const now = parent.thread.updatedAt;
          const rootNodeId = parent.runs[0]!.rootNodeId!;
          const child = (suffix: string, childThreadId: ThreadId) => {
            const subagentId = NodeId.make(`native-child-task-${suffix}`);
            const childProviderId = ProviderThreadId.make(`native-child-provider-${suffix}`);
            const appThread: typeof OrchestrationV2AppThread.Type = {
              ...parent.thread,
              providerInstanceId: turn.modelSelection.instanceId,
              modelSelection: turn.modelSelection,
              id: childThreadId,
              createdBy: "agent",
              creationSource: "provider",
              title: `Native child ${suffix}`,
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
              parentNodeId: rootNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: claudeDriver,
              providerInstanceId: parent.thread.providerInstanceId,
              providerThreadId: childProviderId,
              childThreadId,
              nativeTaskRef: null,
              prompt: `Prompt ${suffix}`,
              title: `Native child ${suffix}`,
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
              id: MessageId.make(`native-child-message-${suffix}`),
              threadId: childThreadId,
              runId: null,
              nodeId: null,
              role: "assistant",
              text: `Transcript ${suffix}`,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
            };
            return { childThreadId, appThread, attestation, message };
          };

          const ownerMismatch = child("owner-mismatch", ownerMismatchId);
          const projectMismatch = child("project-mismatch", projectMismatchId);
          const validSibling = child("valid-sibling", validSiblingId);
          const seed = (
            candidate: typeof ownerMismatch,
            database: string,
            sequence: number,
            childOwner: typeof storedOwner,
            appThread = candidate.appThread,
          ) =>
            withObject(database, (childEngine) =>
              childEngine.recordNativeChildBatch({
                parentThreadId: parent.thread.id,
                parentRunId: turn.runId,
                childThreadId: candidate.childThreadId,
                generation: machine.generation,
                sequence,
                owner: childOwner,
                appThread,
                attestation: candidate.attestation,
                items: [],
              }),
            );

          expect(
            yield* seed(ownerMismatch, ownerMismatchDatabase, 90, {
              ...storedOwner,
              userId: "another-user",
            }),
          ).toEqual({ _tag: "saved" });
          expect(
            yield* seed(projectMismatch, projectMismatchDatabase, 91, storedOwner, {
              ...projectMismatch.appThread,
              projectId: ProjectId.make("another-project"),
            }),
          ).toEqual({ _tag: "saved" });

          const providerItem = (event: Record<string, unknown>): RunnerItem => ({
            kind: "provider",
            runId: turn.runId,
            event: { driver: claudeDriver, ...event },
          });
          const items: Array<RunnerItem> = [];
          for (const candidate of [ownerMismatch, projectMismatch, validSibling]) {
            items.push(
              providerItem({
                type: "app_thread.created",
                appThread: yield* encodeThread(candidate.appThread),
              }),
              providerItem({
                type: "message.updated",
                message: yield* encodeMessage(candidate.message),
              }),
              providerItem({
                type: "subagent.updated",
                subagent: yield* encodeSubagent(candidate.attestation),
              }),
            );
          }

          expect(
            yield* runner.batch({ generation: machine.generation, sequence: 2, items }),
          ).toEqual({ _tag: "ack", sequence: 2 });

          const reports = Context.get(context, TurnReports);
          const current = (yield* snapshot(engine)).projection;
          const record = yield* reports.turn(current, turn.runId);
          expect(record?.log.map(({ message }) => message)).toContain(
            "Native child capture: count=2; reason=child_mismatch.",
          );

          const pending = yield* Context.get(context, ThreadStore.ThreadStore)
            .pendingNativeChildren;
          expect(pending.map(({ childThreadId }) => childThreadId)).toEqual([
            validSibling.childThreadId,
          ]);

          const foreignActor = { ...owner, userId: "another-user" };
          const storedOwnerMismatch = yield* withObject(ownerMismatchDatabase, (childEngine) =>
            childEngine.snapshot(foreignActor),
          );
          const storedProjectMismatch = yield* withObject(projectMismatchDatabase, (childEngine) =>
            childEngine.snapshot(owner),
          );
          const storedValidSibling = yield* withObject(validSiblingDatabase, (childEngine) =>
            childEngine.snapshot(owner),
          );
          expect(storedOwnerMismatch.projection.messages).toEqual([]);
          expect(storedProjectMismatch.projection.messages).toEqual([]);
          expect(storedValidSibling.projection.messages.map(({ text }) => text)).toEqual([
            "Transcript valid-sibling",
          ]);
        }),
      options,
    );
  });
});
