import {
  CommandId,
  MessageId,
  RunId,
  ProjectId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { decideQueuedRunCommand, queuedRunsInDeliveryOrder } from "./queuedRunCommands.ts";
import {
  cancelQueuedEvents,
  finishRunEvents,
  nextQueuedRun,
  resumeQueueEvents,
} from "./runLifecycle.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { decide, decideLaunch } from "./threadDecider.ts";
import { ids } from "./threadEvents.ts";
import { applyEvents } from "./threadProjection.ts";

const threadId = ThreadId.make("thread-queue");
const ctx = { now: DateTime.makeUnsafe("2026-10-18T10:00:00.000Z") };
const apply = (
  projection: OrchestrationV2ThreadProjection | null,
  decision: ReturnType<typeof decide>,
) => {
  if (decision._tag !== "accepted") throw new Error(decision.message);
  const next = applyEvents(projection, decision.events);
  if (next === null) throw new Error("Expected a thread");
  return next;
};
const fixture = () => {
  let projection = apply(
    null,
    decideLaunch(
      null,
      {
        commandId: CommandId.make("launch"),
        threadId,
        projectId: ProjectId.make("scratch"),
        title: "Queue",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: MessageId.make("message-1"), text: "Live", attachments: [] },
      },
      ctx,
    ),
  );
  for (const ordinal of [2, 3, 4]) {
    projection = apply(
      projection,
      decide(
        projection,
        {
          type: "message.dispatch",
          commandId: CommandId.make(`send-${ordinal}`),
          threadId,
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message-${ordinal}`),
          text: `Queued ${ordinal}`,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        },
        ctx,
      ),
    );
  }
  return projection;
};
const edit = (
  ordinal = 2,
  patch: Partial<Extract<OrchestrationV2Command, { type: "queued-run.edit" }>> = {},
) =>
  ({
    type: "queued-run.edit",
    commandId: CommandId.make("edit"),
    threadId,
    runId: ids.run(threadId, ordinal),
    text: "Edited",
    ...patch,
  }) satisfies Extract<OrchestrationV2Command, { type: "queued-run.edit" }>;
const reorder = (ordinal: number, before: number | null) =>
  ({
    type: "queued-run.reorder",
    commandId: CommandId.make("reorder"),
    threadId,
    runId: ids.run(threadId, ordinal),
    beforeRunId: before === null ? null : ids.run(threadId, before),
  }) satisfies Extract<OrchestrationV2Command, { type: "queued-run.reorder" }>;
const order = (projection: OrchestrationV2ThreadProjection) =>
  queuedRunsInDeliveryOrder(projection).map((run) => run.ordinal);

describe("cloud queue decisions", () => {
  it("stores a deterministic order used by start, finish, cancel and resume", () => {
    const original = fixture();
    const command = reorder(4, 2);
    const decision = decide(original, command, ctx);
    expect(decide(original, command, ctx)).toEqual(decision);
    const moved = apply(original, decision);
    expect(order(moved)).toEqual([4, 2, 3]);
    expect(nextQueuedRun(moved)?.ordinal).toBe(4);
    const live = moved.runs[0]!;
    const finished = applyEvents(moved, finishRunEvents(moved, live, "completed", ctx))!;
    expect(finished.runs.find((run) => run.status === "starting")?.ordinal).toBe(4);
    expect(order(finished)).toEqual([2, 3]);
    const cancelled = applyEvents(moved, cancelQueuedEvents(moved, moved.runs[1]!, ctx))!;
    expect(order(cancelled)).toEqual([4, 3]);
    expect(cancelled.messages).toEqual(moved.messages);
    const held = applyEvents(
      moved,
      finishRunEvents(moved, live, "interrupted", ctx, { queue: "hold" }),
    )!;
    expect(nextQueuedRun(held)).toBeUndefined();
    const resumed = applyEvents(held, resumeQueueEvents(held, ctx))!;
    expect(resumed.runs.find((run) => run.status === "starting")?.ordinal).toBe(4);
    expect(order(resumed)).toEqual([2, 3]);
    expect(order(apply(moved, decide(moved, reorder(4, null), ctx)))).toEqual([2, 3, 4]);
  });

  it("uses ordinal ties and missing positions deterministically", () => {
    const original = fixture();
    const projection = {
      ...original,
      runs: original.runs.toReversed().map((run) => ({ ...run, queuePosition: null })),
    };
    expect(order(projection)).toEqual([2, 3, 4]);
    expect(
      order({ ...projection, runs: projection.runs.map((run) => ({ ...run, queuePosition: 1 })) }),
    ).toEqual([2, 3, 4]);
  });

  it("rejects every nonqueued state and stale reorder target without events", () => {
    const original = fixture();
    const statuses: ReadonlyArray<OrchestrationV2Run["status"]> = [
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
    for (const status of statuses) {
      const changed = {
        ...original,
        runs: original.runs.map((run) => (run.ordinal === 2 ? { ...run, status } : run)),
      };
      for (const command of [edit(), reorder(2, null), reorder(3, 2)]) {
        expect(decide(changed, command, ctx)._tag).toBe("rejected");
      }
      expect(changed.messages).toEqual(original.messages);
    }
    expect(decide(original, { ...reorder(2, null), runId: RunId.make("missing") }, ctx)._tag).toBe(
      "rejected",
    );
    expect(decide(original, reorder(2, 2), ctx)._tag).toBe("rejected");
  });

  it("keeps automatic deliveries first and refuses editing or moving them", () => {
    const original = fixture();
    const completionId = original.runs[3]!.userMessageId;
    const automatic = {
      ...original,
      messages: original.messages.map((message) =>
        message.id === completionId
          ? {
              ...message,
              delegatedCompletion: {
                parentRunId: original.runs[0]!.id,
                generation: 1,
                taskIds: [],
              },
            }
          : message,
      ),
    };
    expect(order(automatic)).toEqual([4, 2, 3]);
    for (const command of [edit(4), reorder(4, null), reorder(2, 4)]) {
      expect(decide(automatic, command, ctx)._tag).toBe("rejected");
    }
    const notification = {
      ...original,
      messages: original.messages.map((message) =>
        message.id === completionId
          ? {
              ...message,
              notification: {
                source: { kind: "command" as const },
                outcome: "completed" as const,
                summary: "Ready",
              },
            }
          : message,
      ),
    };
    for (const command of [edit(4), reorder(4, null)]) {
      expect(decide(notification, command, ctx)._tag).toBe("rejected");
    }
  });

  it("edits message and matching transcript together and preserves omitted context and attachments", () => {
    const original = fixture();
    const target = original.messages.find((message) => message.id === MessageId.make("message-2"))!;
    const context = { version: 1 as const, records: [] };
    const attachments = [
      {
        type: "file" as const,
        id: "existing",
        name: "brief.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      },
    ];
    const userItem = original.turnItems.find((item) => item.type === "user_message")!;
    if (userItem.type !== "user_message") throw new Error("Expected user item");
    const projection = {
      ...original,
      messages: original.messages.map((message) =>
        message.id === target.id ? { ...message, context, attachments } : message,
      ),
      turnItems: [
        ...original.turnItems,
        {
          ...userItem,
          id: ids.userItem(ids.run(threadId, 2)),
          runId: ids.run(threadId, 2),
          messageId: target.id,
          text: target.text,
          context,
          attachments,
        },
      ],
    };
    const edited = apply(projection, decide(projection, edit(), ctx));
    expect(edited.messages.find((message) => message.id === target.id)).toMatchObject({
      text: "Edited",
      context,
      attachments,
    });
    expect(
      edited.turnItems.find((item) => item.id === ids.userItem(ids.run(threadId, 2))),
    ).toMatchObject({ text: "Edited", context, attachments });
    const cleared = apply(
      edited,
      decide(edited, edit(2, { attachments: [], context: { version: 1, records: [] } }), ctx),
    );
    expect(cleared.messages.find((message) => message.id === target.id)?.attachments).toEqual([]);
    expect(
      cleared.turnItems.find((item) => item.id === ids.userItem(ids.run(threadId, 2))),
    ).toMatchObject({ attachments: [] });
    expect(edited.runs).toEqual(original.runs);
    expect(decide(projection, edit(2, { text: "  " }), ctx)._tag).toBe("rejected");
    const missing = {
      ...projection,
      messages: projection.messages.filter((message) => message.id !== target.id),
    };
    expect(decideQueuedRunCommand(missing, edit(), ctx)._tag).toBe("rejected");
  });
});
