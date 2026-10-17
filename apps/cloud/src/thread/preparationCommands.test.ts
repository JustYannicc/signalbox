import {
  CommandId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderTurnId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  decidePreparationCommand,
  failedPreparationEvents,
  readyPreparationEvents,
} from "./preparationCommands.ts";
import { applyEvents } from "./threadProjection.ts";
import type { DecisionContext } from "./threadEvents.ts";

const threadId = ThreadId.make("thread:preparation-test");
const runId = RunId.make(`run:${threadId}:1`);
const attemptId = RunAttemptId.make(`attempt:${runId}:1`);
const rootNodeId = NodeId.make(`node:${runId}:root`);
const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
const providerInstanceId = ProviderInstanceId.make("codexAgent");
const now = DateTime.makeUnsafe("2026-10-17T12:00:00.000Z");
const ctx: DecisionContext = { now };

const run = (changes: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
    providerThreadId,
    userMessageId: MessageId.make(`message:${threadId}:1`),
    rootNodeId,
    activeAttemptId: attemptId,
    status: "failed",
    requestedAt: now,
    startedAt: null,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
    workspacePreparation: { type: "root" },
    ...changes,
  }) as unknown as OrchestrationV2Run;

const attempt = (ordinal = 1, changes: Partial<OrchestrationV2RunAttempt> = {}) =>
  ({
    id: RunAttemptId.make(`attempt:${runId}:${ordinal}`),
    runId,
    attemptOrdinal: ordinal,
    rootNodeId,
    providerInstanceId,
    providerThreadId,
    providerTurnId: null,
    reason: ordinal === 1 ? "initial" : "retry",
    status: "failed",
    startedAt: null,
    completedAt: now,
    ...changes,
  }) as unknown as OrchestrationV2RunAttempt;

const rootNode = (changes: Partial<OrchestrationV2ExecutionNode> = {}) =>
  ({
    id: rootNodeId,
    threadId,
    runId,
    parentNodeId: null,
    rootNodeId,
    kind: "root_turn",
    status: "failed",
    countsForRun: true,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: null,
    completedAt: now,
    ...changes,
  }) as unknown as OrchestrationV2ExecutionNode;

const prepItemId = TurnItemId.make(`turn-item:${runId}:preparation`);
const failureItemId = TurnItemId.make(`turn-item:${runId}:preparation-failure:1`);

const preparationItem = (
  changes: Partial<Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>> = {},
) =>
  ({
    id: prepItemId,
    threadId,
    runId,
    nodeId: rootNodeId,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 2,
    status: "failed",
    title: "Workspace preparation failed",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "Preparing workspace",
    output: "setup failed",
    exitCode: 1,
    ...changes,
  }) as unknown as Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

const failureItem = (
  changes: Partial<Extract<OrchestrationV2TurnItem, { readonly type: "error" }>> = {},
) =>
  ({
    id: failureItemId,
    threadId,
    runId,
    nodeId: rootNodeId,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 3,
    status: "failed",
    title: "Workspace preparation failed",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "error",
    failure: {
      class: "unknown",
      message: "Workspace setup failed",
      code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
      retryable: true,
    },
    ...changes,
  }) as unknown as Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

const userMessage = (changes: Partial<OrchestrationV2ConversationMessage> = {}) =>
  ({
    id: MessageId.make(`message:${threadId}:1`),
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text: "Build the thing",
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    ...changes,
  }) as unknown as OrchestrationV2ConversationMessage;

const current = (
  changes: {
    readonly run?: Partial<OrchestrationV2Run>;
    readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
    readonly providerThreads?: ReadonlyArray<OrchestrationV2ProviderThread>;
    readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly archivedAt?: DateTime.Utc | null;
    readonly deletedAt?: DateTime.Utc | null;
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  } = {},
) =>
  ({
    thread: {
      id: threadId,
      archivedAt: changes.archivedAt ?? null,
      deletedAt: changes.deletedAt ?? null,
    },
    runs: changes.runs ?? [run(changes.run)],
    attempts: changes.attempts ?? [attempt()],
    nodes: changes.nodes ?? [rootNode()],
    providerThreads:
      changes.providerThreads ??
      ([
        { id: providerThreadId, appThreadId: threadId },
      ] as unknown as ReadonlyArray<OrchestrationV2ProviderThread>),
    turnItems: changes.turnItems ?? [preparationItem(), failureItem()],
    messages: changes.messages ?? [userMessage()],
    visibleTurnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const retry = (id = "command:retry:1") =>
  ({
    type: "prepared-run.retry",
    commandId: CommandId.make(id),
    threadId,
    runId,
  }) satisfies Extract<OrchestrationV2Command, { readonly type: "prepared-run.retry" }>;

describe("preparation retry command", () => {
  it("records a failed machine preparation, holds queued messages and resumes after the retry connects", () => {
    const queued = {
      ...run(),
      id: RunId.make(`run:${threadId}:2`),
      ordinal: 2,
      userMessageId: MessageId.make(`message:${threadId}:2`),
      status: "queued",
      queueHeld: false,
      completedAt: null,
    } as unknown as OrchestrationV2Run;
    const starting = current({
      run: { status: "starting", completedAt: null },
      runs: [run({ status: "starting", completedAt: null }), queued],
      attempts: [attempt(1, { status: "pending", completedAt: null })],
      nodes: [rootNode({ status: "pending", completedAt: null })],
      turnItems: [],
    });

    const failed = failedPreparationEvents(starting, runId, ctx);
    expect(failed).not.toBeNull();
    if (failed === null) throw new Error("expected preparation failure events");
    expect(failed).toContainEqual(
      expect.objectContaining({
        type: "run.updated",
        payload: expect.objectContaining({
          id: runId,
          status: "failed",
          workspacePreparation: { type: "root" },
        }),
      }),
    );
    expect(failed).toContainEqual(
      expect.objectContaining({
        type: "run.updated",
        payload: expect.objectContaining({ id: queued.id, queueHeld: true }),
      }),
    );
    expect(failed.filter((event) => event.type === "message.updated")).toHaveLength(0);
    expect(
      failed.some(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.type === "error" &&
          event.payload.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
      ),
    ).toBe(true);

    const failedProjection = applyEvents(starting, failed);
    expect(failedProjection).not.toBeNull();
    if (failedProjection === null) throw new Error("expected failed projection");
    const retryDecision = decidePreparationCommand(failedProjection, retry(), ctx);
    expect(retryDecision?._tag).toBe("accepted");
    if (retryDecision?._tag !== "accepted") throw new Error("expected accepted retry");
    const retried = applyEvents(failedProjection, retryDecision.events);
    expect(retried).not.toBeNull();
    if (retried === null) throw new Error("expected retried projection");
    expect(retried.runs.find((candidate) => candidate.id === runId)).toMatchObject({
      activeAttemptId: RunAttemptId.make(`attempt:${runId}:2`),
      status: "preparing",
    });
    expect(retried.runs.find((candidate) => candidate.id === queued.id)?.queueHeld).toBe(false);

    const ready = readyPreparationEvents(retried, runId, ctx);
    expect(ready).toContainEqual(
      expect.objectContaining({
        type: "run.updated",
        payload: expect.objectContaining({ id: runId, status: "starting" }),
      }),
    );
    expect(ready).toContainEqual(
      expect.objectContaining({
        type: "turn-item.updated",
        payload: expect.objectContaining({ id: prepItemId, status: "completed" }),
      }),
    );
  });

  it("creates a new deterministic attempt and resets the failed setup under the same run", () => {
    const projection = current();
    const decision = decidePreparationCommand(projection, retry(), ctx);

    expect(decision?._tag).toBe("accepted");
    if (decision?._tag !== "accepted") throw new Error("expected accepted retry");
    expect(decision.events.map((event) => event.type)).toEqual([
      "turn-item.updated",
      "turn-item.updated",
      "run-attempt.created",
      "node.updated",
      "run.updated",
    ]);
    const createdAttempt = decision.events.find((event) => event.type === "run-attempt.created");
    const updatedNode = decision.events.find((event) => event.type === "node.updated");
    const updatedRun = decision.events.find((event) => event.type === "run.updated");
    const resetPreparation = decision.events.find(
      (event) => event.type === "turn-item.updated" && event.payload.id === prepItemId,
    );
    const retainedUserMessage = projection.messages.find(
      (message) => message.id === run().userMessageId,
    );

    expect(createdAttempt).toMatchObject({
      type: "run-attempt.created",
      payload: {
        id: RunAttemptId.make(`attempt:${runId}:2`),
        runId,
        attemptOrdinal: 2,
        reason: "retry",
        status: "pending",
        providerTurnId: null,
      },
    });
    expect(updatedNode).toMatchObject({ type: "node.updated", payload: { status: "pending" } });
    expect(updatedRun).toMatchObject({
      type: "run.updated",
      payload: {
        id: runId,
        activeAttemptId: RunAttemptId.make(`attempt:${runId}:2`),
        status: "preparing",
        startedAt: null,
        completedAt: null,
      },
    });
    expect(resetPreparation).toMatchObject({
      type: "turn-item.updated",
      payload: {
        id: prepItemId,
        status: "running",
        title: "Preparing workspace",
      },
    });
    expect(resetPreparation).not.toHaveProperty("payload.output");
    expect(resetPreparation).not.toHaveProperty("payload.exitCode");
    expect(retainedUserMessage?.text).toBe("Build the thing");
    expect(decision.events.some((event) => event.type === "message.updated")).toBe(false);
  });

  it("increments from every prior attempt on a later retry", () => {
    const previousRetryId = RunAttemptId.make(`attempt:${runId}:2`);
    const projection = current({
      run: { activeAttemptId: previousRetryId },
      attempts: [attempt(), attempt(2, { id: previousRetryId })],
      turnItems: [
        preparationItem(),
        failureItem({
          id: TurnItemId.make(`turn-item:${runId}:preparation-failure:1`),
          status: "cancelled",
        }),
        failureItem({
          id: TurnItemId.make(`turn-item:${runId}:preparation-failure:2`),
          ordinal: 5,
        }),
      ],
    });

    const decision = decidePreparationCommand(projection, retry("command:retry:2"), ctx);
    expect(decision?._tag).toBe("accepted");
    if (decision?._tag !== "accepted") throw new Error("expected accepted retry");
    expect(decision.events.find((event) => event.type === "run-attempt.created")).toMatchObject({
      payload: {
        id: RunAttemptId.make(`attempt:${runId}:3`),
        attemptOrdinal: 3,
      },
    });
  });

  it("rejects a stale retry after the run moved back into preparation", () => {
    const nextAttemptId = RunAttemptId.make(`attempt:${runId}:2`);
    const projection = current({
      run: { activeAttemptId: nextAttemptId, status: "preparing" },
      attempts: [
        attempt(),
        attempt(2, { id: nextAttemptId, status: "pending", completedAt: null }),
      ],
      turnItems: [
        preparationItem({ status: "running", completedAt: null }),
        failureItem({ status: "cancelled" }),
      ],
    });

    expect(decidePreparationCommand(projection, retry("command:stale-retry"), ctx)).toEqual({
      _tag: "rejected",
      message: `Run ${runId} has no failed workspace preparation to retry.`,
    });
  });

  it("rejects an old preparation error when the active attempt has not failed", () => {
    const currentAttemptId = RunAttemptId.make(`attempt:${runId}:2`);
    const projection = current({
      run: { activeAttemptId: currentAttemptId },
      attempts: [
        attempt(),
        attempt(2, { id: currentAttemptId, status: "pending", completedAt: null }),
      ],
    });

    expect(decidePreparationCommand(projection, retry("command:stale-attempt"), ctx)).toEqual({
      _tag: "rejected",
      message: `Run ${runId} has no failed workspace preparation to retry.`,
    });
  });

  it("rejects provider failures and failures after a turn has started", () => {
    const providerFailure = current({
      turnItems: [
        preparationItem(),
        failureItem({
          failure: { class: "unknown", message: "provider failed", code: null, retryable: true },
        }),
      ],
    });
    const started = current({
      run: { startedAt: now },
      attempts: [attempt(1, { startedAt: now })],
      nodes: [
        rootNode({
          startedAt: now,
          providerTurnId: ProviderTurnId.make("provider-turn:1"),
        }),
      ],
    });

    expect(decidePreparationCommand(providerFailure, retry(), ctx)).toMatchObject({
      _tag: "rejected",
    });
    expect(decidePreparationCommand(started, retry(), ctx)).toMatchObject({ _tag: "rejected" });
  });

  it("rejects active, archived, deleted, and incomplete retry state", () => {
    const activeRun = {
      ...run(),
      id: RunId.make(`run:${threadId}:2`),
      ordinal: 2,
      status: "running",
    } as unknown as OrchestrationV2Run;

    for (const projection of [
      current({ runs: [run(), activeRun] }),
      current({ archivedAt: now }),
      current({ deletedAt: now }),
      current({ turnItems: [preparationItem()] }),
      current({ run: { workspacePreparation: undefined } }),
    ]) {
      expect(decidePreparationCommand(projection, retry(), ctx)).toMatchObject({
        _tag: "rejected",
      });
    }
  });

  it("releases queue holds owned by this failed preparation", () => {
    const queued = {
      ...run(),
      id: RunId.make(`run:${threadId}:2`),
      ordinal: 2,
      userMessageId: MessageId.make(`message:${threadId}:2`),
      status: "queued",
      queueHeld: true,
      completedAt: null,
    } as unknown as OrchestrationV2Run;
    const decision = decidePreparationCommand(current({ runs: [run(), queued] }), retry(), ctx);

    expect(decision?._tag).toBe("accepted");
    if (decision?._tag !== "accepted") throw new Error("expected accepted retry");
    expect(decision.events).toContainEqual(
      expect.objectContaining({
        type: "run.updated",
        payload: expect.objectContaining({ id: queued.id, queueHeld: false }),
      }),
    );
  });
});
