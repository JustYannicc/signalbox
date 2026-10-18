import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { decideLifecycleCommand } from "./lifecycleCommands.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { decide } from "./threadDecider.ts";
import { messageEvent, runEvent, type DecisionContext } from "./threadEvents.ts";
import { applyEvents } from "./threadProjection.ts";

const threadId = ThreadId.make("lifecycle-thread");
const T0 = "2026-10-17T10:00:00.000Z";
const T1 = "2026-10-17T10:01:00.000Z";
const T2 = "2026-10-17T10:02:00.000Z";
const at = (value: string): DecisionContext => ({ now: DateTime.makeUnsafe(value) });

const created = (): OrchestrationV2ThreadProjection => {
  const decision = decide(
    null,
    {
      type: "thread.create",
      commandId: CommandId.make("lifecycle-create"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("lifecycle-project"),
      title: "Lifecycle",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    },
    at(T0),
  );
  if (decision._tag !== "accepted") throw new Error(decision.message);
  return applyEvents(null, decision.events)!;
};

const userMessage = (id: string, createdAt: string): OrchestrationV2ConversationMessage => ({
  createdBy: "user",
  creationSource: "web",
  id: MessageId.make(id),
  threadId,
  runId: RunId.make(`run:${threadId}:1`),
  nodeId: null,
  role: "user",
  text: "Keep this history",
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe(createdAt),
  updatedAt: DateTime.makeUnsafe(createdAt),
});

const settle = (projection: OrchestrationV2ThreadProjection, now = T1) =>
  decideLifecycleCommand(
    projection,
    { type: "thread.settle", commandId: CommandId.make(`settle-${now}`), threadId },
    at(now),
  );

const lifecycle = (
  projection: OrchestrationV2ThreadProjection,
  command: OrchestrationV2Command | OrchestrationV2ServerCommand,
  now = T1,
) => decideLifecycleCommand(projection, command, at(now));

const automaticQueuedProjection = (notification: boolean): OrchestrationV2ThreadProjection => {
  const projection = created();
  const userMessageId = MessageId.make("queued-message");
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "server",
    id: userMessageId,
    threadId,
    runId: RunId.make("run:lifecycle-thread:1"),
    nodeId: null,
    role: "system",
    text: "Queued notice",
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(T1),
    updatedAt: DateTime.makeUnsafe(T1),
    ...(notification
      ? { notification: { source: { kind: "system" }, outcome: "completed", summary: "Done" } }
      : {}),
  };
  const run = {
    id: message.runId!,
    threadId,
    ordinal: 1,
    providerInstanceId: scriptedModelSelection.instanceId,
    modelSelection: scriptedModelSelection,
    providerThreadId: null,
    userMessageId,
    rootNodeId: null,
    activeAttemptId: null,
    status: "queued" as const,
    queuePosition: 1,
    requestedAt: message.createdAt,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  return applyEvents(projection, [
    runEvent(at(T1), "run.created", run),
    messageEvent(at(T1), message),
  ])!;
};

describe("cloud lifecycle command decisions", () => {
  it("settles and reopens reversibly while preserving thread history", () => {
    const empty = created();
    const projection = applyEvents(empty, [messageEvent(at(T0), userMessage("history", T0))])!;
    const settled = settle(projection);
    expect(settled?._tag).toBe("accepted");
    if (settled?._tag !== "accepted") return;

    const settledProjection = applyEvents(projection, settled.events)!;
    expect(settledProjection.thread.settledOverride).toBe("settled");
    expect(settledProjection.thread.settledAt).toEqual(DateTime.makeUnsafe(T1));
    expect(settledProjection.runs).toEqual(projection.runs);
    expect(settledProjection.messages).toEqual(projection.messages);
    expect(settledProjection.checkpoints).toEqual(projection.checkpoints);

    const reopened = lifecycle(
      settledProjection,
      { type: "thread.unsettle", commandId: CommandId.make("unsettle"), threadId, reason: "user" },
      T2,
    );
    expect(reopened?._tag).toBe("accepted");
    if (reopened?._tag !== "accepted") return;
    const reopenedProjection = applyEvents(settledProjection, reopened.events)!;
    expect(reopenedProjection.thread.settledOverride).toBe("active");
    expect(reopenedProjection.thread.settledAt).toBeNull();
    expect(reopenedProjection.thread.unsettledAt).toEqual(DateTime.makeUnsafe(T2));
    expect(reopenedProjection.messages).toEqual(projection.messages);
  });

  it("preserves the first settlement time when a repeated settle is replayed", () => {
    const first = settle(created(), T1);
    if (first?._tag !== "accepted") throw new Error("settle was not accepted");
    const afterFirst = applyEvents(created(), first.events)!;
    const second = settle(afterFirst, T2);
    if (second?._tag !== "accepted") throw new Error("repeat settle was not accepted");
    const afterReplay = applyEvents(afterFirst, second.events)!;

    expect(afterReplay.thread.settledAt).toEqual(DateTime.makeUnsafe(T1));
    expect(afterReplay.thread.updatedAt).toEqual(afterFirst.thread.updatedAt);
  });

  it("rejects live turns and queued user messages, but cancels queued automatic messages", () => {
    const live = {
      ...automaticQueuedProjection(false),
      runs: [
        {
          ...automaticQueuedProjection(false).runs[0]!,
          status: "waiting" as const,
        },
      ],
    };
    expect(settle(live)?._tag).toBe("rejected");

    const queuedUser = automaticQueuedProjection(false);
    expect(settle(queuedUser)?._tag).toBe("rejected");

    const queuedAutomatic = automaticQueuedProjection(true);
    const settled = settle(queuedAutomatic);
    expect(settled?._tag).toBe("accepted");
    if (settled?._tag !== "accepted") return;
    const after = applyEvents(queuedAutomatic, settled.events)!;
    expect(after.runs[0]?.status).toBe("cancelled");
    expect(after.messages).toEqual(queuedAutomatic.messages);
    expect(after.thread.settledOverride).toBe("settled");
  });

  it("refuses a stale auto-settle snapshot after a new message arrives", () => {
    const original = created();
    const afterMessage = applyEvents(original, [
      messageEvent(at(T1), userMessage("new-message", T1)),
    ])!;
    const decision = lifecycle(
      afterMessage,
      {
        type: "thread.auto-settle",
        commandId: CommandId.make("stale-auto-settle"),
        threadId,
        snapshotAt: original.updatedAt,
      },
      T2,
    );
    expect(decision).toEqual({
      _tag: "rejected",
      message: `Thread ${threadId} changed before automatic settlement.`,
    });
  });

  it("reverses automatic-settle opt-out and pin state, and rejects stale reorder", () => {
    const projection = created();
    const disabled = lifecycle(projection, {
      type: "thread.auto-settle.set",
      commandId: CommandId.make("disable-auto"),
      threadId,
      enabled: false,
    });
    if (disabled?._tag !== "accepted") throw new Error("disable auto-settle was not accepted");
    const disabledProjection = applyEvents(projection, disabled.events)!;
    expect(disabledProjection.thread.autoSettleDisabledAt).toEqual(DateTime.makeUnsafe(T1));

    const enabled = lifecycle(
      disabledProjection,
      {
        type: "thread.auto-settle.set",
        commandId: CommandId.make("enable-auto"),
        threadId,
        enabled: true,
      },
      T2,
    );
    if (enabled?._tag !== "accepted") throw new Error("enable auto-settle was not accepted");
    const enabledProjection = applyEvents(disabledProjection, enabled.events)!;
    expect(enabledProjection.thread.autoSettleDisabledAt).toBeNull();

    const pinned = lifecycle(enabledProjection, {
      type: "thread.pin",
      commandId: CommandId.make("pin"),
      threadId,
      orderKey: "a0",
    });
    if (pinned?._tag !== "accepted") throw new Error("pin was not accepted");
    const pinnedProjection = applyEvents(enabledProjection, pinned.events)!;
    expect(pinnedProjection.thread.pinnedAt).toEqual(DateTime.makeUnsafe(T1));
    expect(pinnedProjection.thread.pinOrderKey).toBe("a0");

    const reordered = lifecycle(
      pinnedProjection,
      {
        type: "thread.pin.reorder",
        commandId: CommandId.make("pin-reorder"),
        threadId,
        orderKey: "b0",
      },
      T2,
    );
    if (reordered?._tag !== "accepted") throw new Error("reorder was not accepted");
    const reorderedProjection = applyEvents(pinnedProjection, reordered.events)!;
    expect(reorderedProjection.thread.pinOrderKey).toBe("b0");

    const unpinned = lifecycle(
      reorderedProjection,
      { type: "thread.unpin", commandId: CommandId.make("unpin"), threadId },
      T2,
    );
    if (unpinned?._tag !== "accepted") throw new Error("unpin was not accepted");
    const unpinnedProjection = applyEvents(reorderedProjection, unpinned.events)!;
    expect(unpinnedProjection.thread.pinnedAt).toBeNull();
    expect(unpinnedProjection.thread.pinOrderKey).toBeNull();
    expect(
      lifecycle(unpinnedProjection, {
        type: "thread.pin.reorder",
        commandId: CommandId.make("stale-pin-reorder"),
        threadId,
        orderKey: "c0",
      })?._tag,
    ).toBe("rejected");

    const settled = settle(unpinnedProjection, T2);
    if (settled?._tag !== "accepted") throw new Error("settle before pin was not accepted");
    const settledProjection = applyEvents(unpinnedProjection, settled.events)!;
    const promoted = lifecycle(
      settledProjection,
      { type: "thread.pin", commandId: CommandId.make("pin-settled"), threadId, orderKey: "z0" },
      T2,
    );
    if (promoted?._tag !== "accepted") throw new Error("pin promotion was not accepted");
    const promotedProjection = applyEvents(settledProjection, promoted.events)!;
    expect(promotedProjection.thread.settledOverride).toBe("active");
    expect(promotedProjection.thread.settledAt).toBeNull();
    expect(promotedProjection.thread.pinnedAt).toEqual(DateTime.makeUnsafe(T2));
  });

  it("leaves unrelated commands to the main decider", () => {
    const projection = created();
    expect(
      lifecycle(projection, {
        type: "thread.unarchive",
        commandId: CommandId.make("unarchive"),
        threadId,
      }),
    ).toBeUndefined();
  });
});
