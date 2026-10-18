import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskSource } from "@t3tools/contracts/signalboxAsks";
import { applyAskCommand, compactAskEvents } from "@t3tools/shared/signalboxAsks";
import { mirrorNativeAskEvents } from "@t3tools/shared/signalboxNativeAsks";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { expireRuntimeRequests } from "./expireRuntimeRequests.ts";
import { rollbackEvents } from "./rollbackEvents.ts";
import type { RollbackOperation } from "./rollbackState.ts";
import { applyEvents, threadShellFromProjection } from "./threadProjection.ts";
import { workflowFixture } from "./workflowTestKit.ts";
import { threadEvent } from "./threadEvents.ts";
import { freshDatabase, launch, owner, snapshot, withObject } from "./runnerTesting.ts";

const makeAsk = (threadId: ThreadId, askId: string, source: SignalboxAskSource, now: string) => {
  const raised = applyAskCommand(
    [],
    {
      type: "thread.ask.raise",
      commandId: CommandId.make(`raise:${askId}`),
      threadId,
      askId,
      ask: {
        kind: "blocker",
        source,
        questions: [
          {
            id: `question:${askId}`,
            question: `Question for ${askId}?`,
            why: "This decision is needed.",
            unblocks: "The work waiting on the answer.",
            recommendation: null,
            options: [],
            blocking: true,
            decisionOwner: "Thread owner",
            surface: { kind: "kit", component: "native-question" },
          },
        ],
      },
    },
    now,
  );
  if (!raised.ok) throw new Error(raised.error);
  return raised.asks[0]!;
};

const rollbackOperation = (
  projection: Parameters<typeof rollbackEvents>[0],
  runId: RunId,
  targetOrdinal: number,
  commandId: string,
): RollbackOperation => ({
  version: 1,
  commandId: CommandId.make(commandId),
  threadId: projection.thread.id,
  userId: owner.userId,
  driveId: null,
  restoreFiles: false,
  scopeId: CheckpointScopeId.make(`scope:${commandId}`),
  checkpointId: CheckpointId.make(`checkpoint:${commandId}`),
  runId,
  targetOrdinal,
  boundary: targetOrdinal === 0 ? "start" : "end",
  expectedThread: null,
  expectedWip: null,
  generation: 1,
  stage: "conversation-updated",
});

describe("rollback thread obligations", () => {
  it.effect.each([false, true])(
    "withdraws removed native asks and keeps their audit, archived=%s",
    (archived) =>
      withObject(freshDatabase(), (engine) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const initial = yield* snapshot(engine);
          const projection = initial.projection;
          const run = projection.runs[0]!;
          const root = projection.nodes.find((node) => node.id === run.rootNodeId)!;
          const now = projection.updatedAt;
          const requestId = RuntimeRequestId.make("baseline-native-request");
          const requestNode = {
            ...root,
            id: NodeId.make("baseline-native-request-node"),
            parentNodeId: root.id,
            kind: "user_input_request",
            status: "waiting",
            runtimeRequestId: requestId,
          } satisfies OrchestrationV2ExecutionNode;
          const request = {
            id: requestId,
            nodeId: requestNode.id,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("baseline-native-session"),
            },
            createdAt: now,
            resolvedAt: null,
          } satisfies OrchestrationV2RuntimeRequest;
          const requestItem = {
            id: TurnItemId.make("baseline-native-request-item"),
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: requestNode.id,
            providerThreadId: requestNode.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [
              { id: "native-question", header: "Choice", question: "Which option?", options: [] },
            ],
          } satisfies OrchestrationV2TurnItem;
          const nowIso = DateTime.formatIso(now);
          const nativeAsk = makeAsk(
            projection.thread.id,
            `native:${requestId}`,
            { kind: "native", requestId },
            nowIso,
          );
          const manualAsk = makeAsk(
            projection.thread.id,
            "manual-question",
            { kind: "agent" },
            nowIso,
          );
          const automationAsk = makeAsk(
            projection.thread.id,
            "automation-question",
            { kind: "automation", runId: "automation-run", stepKey: "approval" },
            nowIso,
          );
          const before = {
            ...projection,
            runs: [{ ...run, status: "interrupted", completedAt: now }],
            thread: {
              ...projection.thread,
              archivedAt: archived ? now : null,
              asks: [nativeAsk, manualAsk, automationAsk].map((ask) =>
                archived
                  ? ({
                      ...ask,
                      status: "archived",
                      rounds: ask.rounds.map((round) => ({ ...round, closedAt: nowIso })),
                    } satisfies SignalboxAsk)
                  : ask,
              ),
            },
            nodes: [...projection.nodes, requestNode],
            runtimeRequests: [request],
            turnItems: [...projection.turnItems, requestItem],
          } satisfies Parameters<typeof rollbackEvents>[0];
          const events = rollbackEvents(
            before,
            rollbackOperation(before, run.id, 0, "baseline-undo"),
            { now },
          );
          const expired = expireRuntimeRequests(before, events);
          const mirrored = mirrorNativeAskEvents(before, expired);
          const compacted = compactAskEvents(before.thread.id, before.thread.asks, mirrored);
          const undone = applyEvents(before, compacted)!;
          const after = archived
            ? applyEvents(
                undone,
                mirrorNativeAskEvents(undone, [
                  threadEvent({ now }, "thread.metadata-updated", {
                    ...undone.thread,
                    archivedAt: null,
                  }),
                ]),
              )!
            : undone;
          const shell = threadShellFromProjection(after);

          expect(after.runs.find((candidate) => candidate.id === run.id)?.status).toBe(
            "rolled_back",
          );
          expect(
            after.runtimeRequests.find((candidate) => candidate.id === requestId),
          ).toMatchObject({
            status: "expired",
          });
          expect(
            after.turnItems.find(
              (item) => item.type === "user_input_request" && item.requestId === requestId,
            ),
          ).toMatchObject({ status: "waiting", requestId });
          const withdrawnAsk = after.thread.asks?.find((ask) => ask.id === nativeAsk.id);
          expect(withdrawnAsk).toMatchObject({
            status: "withdrawn",
            source: { kind: "native", requestId },
            rounds: [
              {
                number: 1,
                questionIds: [`question:${nativeAsk.id}`],
                answers: [],
                closedAt: nowIso,
              },
            ],
          });
          expect(withdrawnAsk?.questions).toEqual(nativeAsk.questions);
          expect(shell.pendingRuntimeRequest).toBeNull();
          expect(shell.asks?.map((ask) => ask.id).toSorted()).toEqual(
            [automationAsk.id, manualAsk.id].toSorted(),
          );
          expect(
            after.thread.asks
              ?.filter((ask) => ask.status === "pending")
              .map((ask) => ask.id)
              .toSorted(),
          ).toEqual([automationAsk.id, manualAsk.id].toSorted());
        }),
      ),
  );

  it.effect("keeps active workflows from valid runs out of the rolled-back task list", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const projection = (yield* snapshot(engine)).projection;
        const sourceRun = projection.runs[0]!;
        const now = projection.updatedAt;
        const retainedRun = {
          ...sourceRun,
          ordinal: 1,
          status: "completed",
          completedAt: now,
        } satisfies OrchestrationV2Run;
        const removedRun = {
          ...sourceRun,
          id: RunId.make("run:undo-target"),
          ordinal: 2,
          status: "completed",
          completedAt: now,
        } satisfies OrchestrationV2Run;
        const laterRun = {
          ...sourceRun,
          id: RunId.make("run:after-undo"),
          ordinal: 3,
          status: "completed",
          completedAt: now,
        } satisfies OrchestrationV2Run;
        const templates = workflowFixture(projection, { now }).tasks;
        const removedTask = {
          ...templates[0]!,
          id: NodeId.make("workflow-from-removed-run"),
          runId: removedRun.id,
        };
        const retainedTask = {
          ...templates[2]!,
          id: NodeId.make("workflow-from-retained-run"),
          runId: retainedRun.id,
        };
        const before = {
          ...projection,
          runs: [retainedRun, removedRun],
          subagents: [removedTask, retainedTask],
        };
        const rolledBack = applyEvents(
          before,
          rollbackEvents(before, rollbackOperation(before, removedRun.id, 1, "undo-second-run"), {
            now,
          }),
        )!;
        const afterLaterTurn = { ...rolledBack, runs: [...rolledBack.runs, laterRun] };
        const shell = threadShellFromProjection(afterLaterTurn);

        expect(afterLaterTurn.runs.find((run) => run.id === removedRun.id)?.status).toBe(
          "rolled_back",
        );
        expect(afterLaterTurn.subagents.map((task) => [task.id, task.status]).toSorted()).toEqual(
          [
            [removedTask.id, "running"],
            [retainedTask.id, "running"],
          ].toSorted(),
        );
        expect(shell.pendingBackgroundTasks?.map((task) => task.taskId)).toEqual([retainedTask.id]);
      }),
    ),
  );
});
