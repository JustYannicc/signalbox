import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { decideQueuedRunCommand, queuedRunsInDeliveryOrder } from "./queuedRunCommands.ts";
import type { DecisionContext } from "./threadEvents.ts";

const threadId = ThreadId.make("thread:queue-test");
const providerInstanceId = ProviderInstanceId.make("codexAgent");
const now = "2026-10-17T10:00:00.000Z";
const ctx = { now } as unknown as DecisionContext;

type RunSpec = {
  readonly ordinal: number;
  readonly status?: OrchestrationV2Run["status"];
  readonly queuePosition?: number | null;
  readonly queueHeld?: boolean;
};

const run = ({ ordinal, status = "queued", queuePosition = ordinal, queueHeld }: RunSpec) =>
  ({
    id: RunId.make(`run:${threadId}:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition,
    ...(queueHeld === undefined ? {} : { queueHeld }),
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  }) as unknown as OrchestrationV2Run;

const message = (
  target: OrchestrationV2Run,
  options: {
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly delegatedCompletion?: OrchestrationV2ConversationMessage["delegatedCompletion"];
    readonly notification?: OrchestrationV2ConversationMessage["notification"];
    readonly text?: string;
  } = {},
) =>
  ({
    id: target.userMessageId,
    threadId,
    runId: target.id,
    nodeId: null,
    role: "user",
    text: options.text ?? `message ${target.ordinal}`,
    attachments: options.attachments ?? [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    ...(options.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: options.delegatedCompletion }),
    ...(options.notification === undefined ? {} : { notification: options.notification }),
  }) as unknown as OrchestrationV2ConversationMessage;

const userItem = (
  target: OrchestrationV2Run,
  attachments: ReadonlyArray<ChatAttachment> = [],
): OrchestrationV2TurnItem =>
  ({
    id: `turn-item:${target.id}:user`,
    threadId,
    runId: target.id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: target.ordinal * 1_000_000,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: target.userMessageId,
    inputIntent: "queued_turn",
    text: `message ${target.ordinal}`,
    attachments,
  }) as unknown as OrchestrationV2TurnItem;

const projection = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage> = runs.map((candidate) =>
    message(candidate),
  ),
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
) =>
  ({
    thread: { id: threadId, deletedAt: null },
    runs,
    messages,
    turnItems,
  }) as unknown as OrchestrationV2ThreadProjection;

const editCommand = (
  target: OrchestrationV2Run,
  changes: Partial<Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>> = {},
) =>
  ({
    type: "queued-run.edit",
    commandId: CommandId.make(`command:edit:${target.id}`),
    threadId,
    runId: target.id,
    text: "edited message",
    ...changes,
  }) satisfies Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>;

const reorderCommand = (target: OrchestrationV2Run, beforeRunId: RunId | null) =>
  ({
    type: "queued-run.reorder",
    commandId: CommandId.make(`command:reorder:${target.id}`),
    threadId,
    runId: target.id,
    beforeRunId,
  }) satisfies Extract<OrchestrationV2Command, { readonly type: "queued-run.reorder" }>;

describe("queued run commands", () => {
  it("keeps delegated completions first and records the reordered delivery positions", () => {
    const first = run({ ordinal: 1, queuePosition: 3 });
    const second = run({ ordinal: 2, queuePosition: 2 });
    const third = run({ ordinal: 3, queuePosition: 1 });
    const completion = run({ ordinal: 4, queuePosition: 4 });
    const before = projection(
      [first, second, third, completion],
      [
        message(first),
        message(second),
        message(third),
        message(completion, {
          delegatedCompletion: {
            parentRunId: first.id,
            generation: 1,
            taskIds: [],
          },
        }),
      ],
    );

    expect(queuedRunsInDeliveryOrder(before).map((candidate) => candidate.id)).toEqual([
      completion.id,
      third.id,
      second.id,
      first.id,
    ]);
    const decision = decideQueuedRunCommand(before, reorderCommand(first, third.id), ctx);

    expect(decision?._tag).toBe("accepted");
    if (decision?._tag !== "accepted") throw new Error("expected accepted reorder");
    expect(
      decision.events.map((event) =>
        event.type === "run.updated" ? [event.payload.id, event.payload.queuePosition] : null,
      ),
    ).toEqual([
      [completion.id, 1],
      [first.id, 2],
      [third.id, 3],
      [second.id, 4],
    ]);
  });

  it("rejects stale edits and reorders after cancel, promotion, or queue start", () => {
    const queued = run({ ordinal: 1 });
    const staleStates: ReadonlyArray<OrchestrationV2Run["status"]> = [
      "preparing",
      "starting",
      "running",
      "waiting",
      "completed",
      "interrupted",
      "failed",
      "cancelled",
      "rolled_back",
    ];

    for (const status of staleStates) {
      const changed = { ...queued, status };
      const current = projection([changed]);
      const edit = decideQueuedRunCommand(current, editCommand(queued), ctx);
      const reorder = decideQueuedRunCommand(current, reorderCommand(queued, null), ctx);
      expect(edit).toEqual({
        _tag: "rejected",
        message: `Run ${queued.id} is not queued.`,
      });
      expect(reorder).toEqual({
        _tag: "rejected",
        message: `Run ${queued.id} is not queued.`,
      });
    }
  });

  it("rejects missing or automatic reorder targets without changing the queue", () => {
    const moving = run({ ordinal: 1 });
    const automatic = run({ ordinal: 2 });
    const current = projection(
      [moving, automatic],
      [
        message(moving),
        message(automatic, {
          delegatedCompletion: { parentRunId: moving.id, generation: 1, taskIds: [] },
        }),
      ],
    );

    expect(
      decideQueuedRunCommand(current, reorderCommand(moving, RunId.make("missing")), ctx),
    ).toEqual({
      _tag: "rejected",
      message: "Queue target missing is not queued.",
    });
    expect(decideQueuedRunCommand(current, reorderCommand(moving, automatic.id), ctx)).toEqual({
      _tag: "rejected",
      message: "Queued messages cannot be reordered ahead of automatic completion delivery.",
    });
    expect(decideQueuedRunCommand(current, reorderCommand(automatic, null), ctx)).toEqual({
      _tag: "rejected",
      message: "Automatic completion deliveries cannot be reordered.",
    });
  });

  it("edits the durable message and existing user item together, preserving omitted attachments", () => {
    const queued = run({ ordinal: 1 });
    const existing: ChatAttachment = {
      type: "file",
      id: "thread-queue-test-12345678-1234-1234-1234-123456789abc-txt",
      name: "brief.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const current = projection(
      [queued],
      [message(queued, { attachments: [existing] })],
      [userItem(queued, [existing])],
    );

    const decision = decideQueuedRunCommand(current, editCommand(queued), ctx);
    expect(decision?._tag).toBe("accepted");
    if (decision?._tag !== "accepted") throw new Error("expected accepted edit");
    expect(decision.events.map((event) => event.type)).toEqual([
      "message.updated",
      "turn-item.updated",
    ]);
    const [messageUpdate, itemUpdate] = decision.events;
    if (messageUpdate?.type !== "message.updated" || itemUpdate?.type !== "turn-item.updated") {
      throw new Error("expected the message and transcript events");
    }
    expect(messageUpdate.payload).toMatchObject({
      text: "edited message",
      attachments: [existing],
    });
    expect(itemUpdate.payload).toMatchObject({
      text: "edited message",
      attachments: [existing],
    });
    expect(messageUpdate.payload.updatedAt).toBe(now);
    expect(itemUpdate.payload.updatedAt).toBe(now);
  });

  it("replaces attachments on both records and refuses empty text", () => {
    const queued = run({ ordinal: 1 });
    const oldAttachment: ChatAttachment = {
      type: "file",
      id: "thread-queue-test-12345678-1234-1234-1234-123456789abc-old",
      name: "old.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    };
    const replacement: ChatAttachment = {
      type: "file",
      id: "thread-queue-test-12345678-1234-1234-1234-123456789abc-new",
      name: "new.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
    };
    const current = projection(
      [queued],
      [message(queued, { attachments: [oldAttachment] })],
      [userItem(queued, [oldAttachment])],
    );

    const decision = decideQueuedRunCommand(
      current,
      editCommand(queued, { attachments: [replacement] }),
      ctx,
    );
    expect(decision?._tag).toBe("accepted");
    if (decision?._tag !== "accepted") throw new Error("expected accepted edit");
    expect(decision.events).toMatchObject([
      { type: "message.updated", payload: { attachments: [replacement] } },
      { type: "turn-item.updated", payload: { attachments: [replacement] } },
    ]);

    expect(decideQueuedRunCommand(current, editCommand(queued, { text: "   " }), ctx)).toEqual({
      _tag: "rejected",
      message: `Queued run ${queued.id} cannot be edited to an empty message.`,
    });
  });

  it("returns undefined for queue commands owned by the thread decider", () => {
    const queued = run({ ordinal: 1 });
    const cancel = {
      type: "queued-run.cancel",
      commandId: CommandId.make(`command:cancel:${queued.id}`),
      threadId,
      runId: queued.id,
    } satisfies Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>;

    expect(decideQueuedRunCommand(projection([queued]), cancel, ctx)).toBeUndefined();
  });
});
