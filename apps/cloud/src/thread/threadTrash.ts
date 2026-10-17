import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { activeRun, finishRunEvents } from "./runLifecycle.ts";
import { messageEvent, nodeEvent, threadEvent, turnItemEvent } from "./threadEvents.ts";
import type { DecisionContext } from "./threadEvents.ts";

/** Hides the thread and interrupts active work while retaining its queued runs. */
export const trashEvents = (
  projection: OrchestrationV2ThreadProjection,
  deletedAt: number,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const now = DateTime.makeUnsafe(deletedAt);
  const context: DecisionContext = { now };
  const events: Array<OrchestrationV2DomainEvent> = [
    threadEvent(context, "thread.deleted", {
      ...projection.thread,
      deletedAt: projection.thread.deletedAt ?? now,
      titleRegeneration: null,
      updatedAt: now,
    }),
  ];

  const active = activeRun(projection);
  if (active === undefined) return events;

  const liveStatuses = new Set(["pending", "running", "waiting"]);
  const interruptedItems = projection.turnItems
    .filter((item) => item.runId === active.id && liveStatuses.has(item.status))
    .map((item) => ({
      ...item,
      status: "interrupted" as const,
      completedAt: now,
      updatedAt: now,
      ...("streaming" in item ? { streaming: false } : {}),
    }));
  const stoppedMessages = projection.messages
    .filter((message) => message.runId === active.id && message.streaming)
    .map((message) => ({ ...message, streaming: false, updatedAt: now }));

  // `keep` leaves every queued run unchanged. The deletedAt gate prevents new
  // runs from starting until restore clears the marker.
  events.push(
    ...finishRunEvents(projection, active, "interrupted", context, {
      queue: "keep",
      leading: [
        ...interruptedItems.map((item) => turnItemEvent(context, item)),
        ...stoppedMessages.map((message) => messageEvent(context, message)),
      ],
    }),
  );
  for (const node of projection.nodes) {
    if (
      node.runId !== active.id ||
      node.id === active.rootNodeId ||
      (node.status !== "pending" && node.status !== "running" && node.status !== "waiting")
    ) {
      continue;
    }
    events.push(nodeEvent(context, { ...node, status: "interrupted", completedAt: now }));
  }
  return events;
};

/** Clears only the trash marker, preserving the rest of the thread's last projection exactly. */
export const restoreEvents = (
  projection: OrchestrationV2ThreadProjection,
  now: DateTime.Utc,
): ReadonlyArray<OrchestrationV2DomainEvent> =>
  projection.thread.deletedAt === null
    ? []
    : [
        threadEvent({ now }, "thread.metadata-updated", {
          ...projection.thread,
          deletedAt: null,
          updatedAt: now,
        }),
      ];
