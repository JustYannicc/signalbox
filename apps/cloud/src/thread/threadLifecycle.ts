import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { activeRun } from "./runLifecycle.ts";
import { interruptRunEvents } from "./scriptedTurn.ts";
import type { DecisionContext } from "./threadEvents.ts";
import { runEvent, threadEvent } from "./threadEvents.ts";
import { applyEvents } from "./threadProjection.ts";

type SettleCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.settle" | "thread.auto-settle" }
>;

export type LifecycleDecision =
  | { readonly _tag: "accepted"; readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }
  | { readonly _tag: "rejected"; readonly message: string };

const accept = (events: ReadonlyArray<OrchestrationV2DomainEvent> = []): LifecycleDecision => ({
  _tag: "accepted",
  events,
});
const reject = (message: string): LifecycleDecision => ({ _tag: "rejected", message });

const settledBlocker = (projection: OrchestrationV2ThreadProjection, skipQueued = false) => {
  if (
    projection.runs.some(
      (run) =>
        run.status === "preparing" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting",
    )
  ) {
    return "This thread is still working. Stop it or let it finish, then settle it.";
  }
  if (!skipQueued && projection.runs.some((run) => run.status === "queued")) {
    return "This thread has a queued message. Send it or remove it from the queue before settling.";
  }
  return null;
};

const stopForEarlySettlement = (
  projection: OrchestrationV2ThreadProjection,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const run = activeRun(projection);
  if (run !== undefined) return interruptRunEvents(projection, run, ctx, true);
  return projection.runs
    .filter((candidate) => candidate.status === "queued")
    .map((candidate) => runEvent(ctx, "run.updated", { ...candidate, queueHeld: true }));
};

/** Settlement is a thread event; cloud records archive on the thread itself. */
export function settle(
  projection: OrchestrationV2ThreadProjection,
  command: SettleCommand,
  ctx: DecisionContext,
): LifecycleDecision {
  if (command.type === "thread.auto-settle") {
    if (projection.thread.settledOverride !== null) {
      return reject("This thread has an explicit settlement override.");
    }
    if (projection.thread.archivedAt !== null) {
      return reject("This thread is already archived.");
    }
  }
  if (
    command.snapshotAt !== undefined &&
    DateTime.toEpochMillis(projection.updatedAt) > DateTime.toEpochMillis(command.snapshotAt)
  ) {
    if (command.type === "thread.settle") return accept();
    return reject("This thread changed before its done-condition held.");
  }
  const earlyStop =
    command.type === "thread.settle" &&
    command.stopWork === true &&
    command.snapshotAt === undefined;
  const stopEvents = earlyStop ? stopForEarlySettlement(projection, ctx) : [];
  const stoppedProjection =
    stopEvents.length === 0 ? projection : (applyEvents(projection, stopEvents) ?? projection);
  const blocker = settledBlocker(stoppedProjection, earlyStop);
  if (blocker !== null) {
    return command.type === "thread.settle" && command.snapshotAt !== undefined
      ? accept()
      : reject(blocker);
  }

  const existing = stoppedProjection.thread;
  const alreadySettled =
    existing.settledOverride === "settled" &&
    existing.settledAt !== null &&
    existing.archivedAt !== null;
  const settledAt = alreadySettled ? existing.settledAt : (command.settledAt ?? ctx.now);
  const thread: OrchestrationV2AppThread = {
    ...existing,
    archivedAt: existing.archivedAt ?? settledAt,
    settledOverride: "settled",
    settledAt,
    unsettledAt: null,
    updatedAt: alreadySettled ? existing.updatedAt : ctx.now,
  };
  return accept([...stopEvents, threadEvent(ctx, "thread.settled", thread)]);
}

/** A person reopening a settled task opts out of the old completion signal. */
export function unsettle(
  projection: OrchestrationV2ThreadProjection,
  ctx: DecisionContext,
): LifecycleDecision {
  if (projection.thread.settledOverride !== "settled") {
    return reject("This thread is not settled.");
  }
  return accept([
    threadEvent(ctx, "thread.unsettled", {
      ...projection.thread,
      archivedAt: null,
      settledOverride: "active",
      settledAt: null,
      unsettledAt: ctx.now,
      updatedAt: ctx.now,
    }),
  ]);
}

/** Reopens the thread before a new message is recorded, preserving its work. */
export function reopenForMessage(
  thread: OrchestrationV2AppThread,
  ctx: DecisionContext,
): {
  readonly thread: OrchestrationV2AppThread;
  readonly event: OrchestrationV2DomainEvent;
} | null {
  if (thread.settledOverride !== null) {
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
