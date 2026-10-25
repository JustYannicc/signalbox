import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  accept,
  decideLifecycleCommand,
  type LifecycleDecision,
  reject,
} from "./lifecycleCommands.ts";
import { activeRun } from "./runLifecycle.ts";
import { interruptRunEvents } from "./scriptedTurn.ts";
import type { DecisionContext } from "./threadEvents.ts";
import { runEvent, threadEvent } from "./threadEvents.ts";
import { applyEvents } from "./threadProjection.ts";

export type { LifecycleDecision };

type SettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.settle" }>;

const settledAndArchived = (thread: OrchestrationV2AppThread) =>
  thread.archivedAt !== null && thread.settledOverride === "settled";

/** Early settlement stops the live run and holds what is queued behind it. */
const stopEvents = (projection: OrchestrationV2ThreadProjection, ctx: DecisionContext) => {
  const run = activeRun(projection);
  if (run !== undefined) return interruptRunEvents(projection, run, ctx, true);
  return projection.runs
    .filter((candidate) => candidate.status === "queued")
    .map((candidate) => runEvent(ctx, "run.updated", { ...candidate, queueHeld: true }));
};

/**
 * A person settling a task (#671) also archives it, and may stop its work first.
 * A done-condition's settle (`snapshotAt`) quietly does nothing when the task
 * changed after it looked, or can't settle now.
 */
function settle(
  projection: OrchestrationV2ThreadProjection,
  command: SettleCommand,
  ctx: DecisionContext,
): LifecycleDecision {
  const { snapshotAt } = command;
  if (settledAndArchived(projection.thread)) return accept();
  if (
    snapshotAt !== undefined &&
    DateTime.toEpochMillis(projection.updatedAt) > DateTime.toEpochMillis(snapshotAt)
  ) {
    return accept();
  }
  const stopped = command.stopWork === true && snapshotAt === undefined;
  const stops = stopped ? stopEvents(projection, ctx) : [];
  const current = stops.length === 0 ? projection : (applyEvents(projection, stops) ?? projection);
  const decision = decideLifecycleCommand(current, command, ctx, { archive: true, stopped });
  if (decision?._tag !== "accepted") {
    return snapshotAt !== undefined
      ? accept()
      : (decision ?? reject("This thread can't be settled."));
  }
  return accept([...stops, ...decision.events]);
}

/** Reopening a settled task brings it out of the archive; its work stays as it was. */
const reopenSettled = (thread: OrchestrationV2AppThread, ctx: DecisionContext) =>
  threadEvent(ctx, "thread.unsettled", {
    ...thread,
    archivedAt: null,
    settledOverride: "active",
    settledAt: null,
    unsettledAt: ctx.now,
    updatedAt: ctx.now,
  });

/** Thread lifecycle commands: task behavior here, everything generic in `decideLifecycleCommand`. */
export function decide(
  projection: OrchestrationV2ThreadProjection,
  command: OrchestrationV2Command,
  ctx: DecisionContext,
): LifecycleDecision | undefined {
  const { thread } = projection;
  switch (command.type) {
    case "thread.settle":
      return settle(projection, command, ctx);
    case "thread.unsettle":
    case "thread.unarchive":
      if (settledAndArchived(thread)) return accept([reopenSettled(thread, ctx)]);
      return command.type === "thread.unsettle"
        ? decideLifecycleCommand(projection, command, ctx)
        : undefined;
    case "thread.pin": {
      // Pinning promotes a settled task back into the list, so it leaves the archive first.
      if (!settledAndArchived(thread)) return decideLifecycleCommand(projection, command, ctx);
      const reopened = reopenSettled(thread, ctx);
      const decision = decideLifecycleCommand(
        applyEvents(projection, [reopened]) ?? projection,
        command,
        ctx,
      );
      return decision?._tag === "accepted" ? accept([reopened, ...decision.events]) : decision;
    }
    default:
      return decideLifecycleCommand(projection, command, ctx);
  }
}

/** Reopens the thread before a new message is recorded, preserving its work. */
export function reopenForMessage(
  thread: OrchestrationV2AppThread,
  ctx: DecisionContext,
): {
  readonly thread: OrchestrationV2AppThread;
  readonly event: OrchestrationV2DomainEvent;
} | null {
  if (thread.settledOverride !== null || thread.settledAt !== null) {
    const reopened = {
      ...thread,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : ctx.now,
      updatedAt: ctx.now,
    };
    return { thread: reopened, event: threadEvent(ctx, "thread.unsettled", reopened) };
  }
  if (thread.archivedAt !== null) {
    const reopened = { ...thread, archivedAt: null, updatedAt: ctx.now };
    return { thread: reopened, event: threadEvent(ctx, "thread.unarchived", reopened) };
  }
  return null;
}
