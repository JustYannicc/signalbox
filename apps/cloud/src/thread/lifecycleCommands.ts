import {
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { cancelQueuedEvents, isLiveRun } from "./runLifecycle.ts";
import { type DecisionContext, nodeEvent, threadEvent, unstampedEventId } from "./threadEvents.ts";
import { applyEvents } from "./threadProjection.ts";

type LifecycleCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.settle"
      | "thread.auto-settle"
      | "thread.unsettle"
      | "thread.auto-settle.set"
      | "thread.pin"
      | "thread.unpin"
      | "thread.pin.reorder";
  }
>;

export type LifecycleDecision =
  | { readonly _tag: "accepted"; readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }
  | { readonly _tag: "rejected"; readonly message: string };

export const accept = (
  events: ReadonlyArray<OrchestrationV2DomainEvent> = [],
): LifecycleDecision => ({
  _tag: "accepted",
  events,
});

export const reject = (message: string): LifecycleDecision => ({ _tag: "rejected", message });

/**
 * signalbox: how a person settling a task (#671) differs. `archive` archives it too,
 * and may settle an already archived thread in place. `stopped` follows an early
 * stop: open questions are cancelled and messages it held stay queued for a reopen.
 */
export interface TaskSettleOptions {
  readonly archive?: boolean;
  readonly stopped?: boolean;
}

const isLifecycleCommand = (
  command: OrchestrationV2Command | OrchestrationV2ServerCommand,
): command is LifecycleCommand =>
  command.type === "thread.settle" ||
  command.type === "thread.auto-settle" ||
  command.type === "thread.unsettle" ||
  command.type === "thread.auto-settle.set" ||
  command.type === "thread.pin" ||
  command.type === "thread.unpin" ||
  command.type === "thread.pin.reorder";

const automaticMessageIds = (projection: OrchestrationV2ThreadProjection) =>
  new Set(
    projection.messages
      .filter(
        (message) =>
          message.notification !== undefined || message.delegatedCompletion !== undefined,
      )
      .map((message) => message.id),
  );

const cancelUserInputRequestEvents = (
  projection: OrchestrationV2ThreadProjection,
  request: (typeof projection.runtimeRequests)[number],
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
  return [
    {
      id: unstampedEventId,
      threadId: projection.thread.id,
      ...(node?.runId == null ? {} : { runId: node.runId }),
      nodeId: request.nodeId,
      occurredAt: ctx.now,
      type: "runtime-request.updated",
      payload: { ...request, status: "resolved", resolvedAt: ctx.now, decision: "cancel" },
    },
    ...(node === undefined
      ? []
      : [nodeEvent(ctx, { ...node, status: "cancelled", completedAt: ctx.now })]),
  ];
};

/**
 * Decides thread-global lifecycle commands against one cloud projection.
 * Undefined means the caller owns the command or the projection is for a
 * different thread. Settling only changes metadata and cancels automatic
 * queue entries; it never removes transcript, checkpoint or provider state.
 */
export function decideLifecycleCommand(
  projection: OrchestrationV2ThreadProjection,
  command: OrchestrationV2Command | OrchestrationV2ServerCommand,
  ctx: DecisionContext,
  task: TaskSettleOptions = {},
): LifecycleDecision | undefined {
  if (!isLifecycleCommand(command) || command.threadId !== projection.thread.id) return undefined;

  const { thread } = projection;
  const archiveInPlace = task.archive === true && command.type === "thread.settle";
  if (thread.archivedAt !== null && !archiveInPlace) {
    return reject(`Thread ${command.threadId} is archived.`);
  }

  if (command.type === "thread.auto-settle") {
    if (
      thread.settledOverride !== null ||
      DateTime.toEpochMillis(projection.updatedAt) > DateTime.toEpochMillis(command.snapshotAt)
    ) {
      return reject(`Thread ${command.threadId} changed before automatic settlement.`);
    }
  }

  if (command.type === "thread.settle" || command.type === "thread.auto-settle") {
    const automaticIds = automaticMessageIds(projection);
    const queuedRuns = projection.runs.filter((run) => run.status === "queued");
    const queuedMessages = queuedRuns.filter(
      (run) =>
        !automaticIds.has(run.userMessageId) && !(task.stopped === true && run.queueHeld === true),
    );
    const pendingRequests = projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    );
    const blockingRequest = pendingRequests.find(
      (request) => request.kind !== "user_input" || request.responseCapability.type !== "message",
    );
    if (blockingRequest !== undefined && task.stopped !== true) {
      return reject(
        `Thread ${command.threadId} is waiting on an approval or question. Answer it before settling.`,
      );
    }

    if (projection.runs.some(isLiveRun)) {
      return reject(`Thread ${command.threadId} is still running. Stop it before settling.`);
    }

    if (queuedMessages.length > 0) {
      return reject(
        `Thread ${command.threadId} has a queued message. Send it or remove it from the queue before settling.`,
      );
    }

    // Fold each automatic cancellation before deciding the next one, so queue
    // positions remain deterministic and every original user message stays.
    let current = projection;
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const request of pendingRequests) {
      const cancelled = cancelUserInputRequestEvents(current, request, ctx);
      events.push(...cancelled);
      current = applyEvents(current, cancelled) ?? current;
    }
    for (const run of queuedRuns) {
      if (!automaticIds.has(run.userMessageId)) continue;
      const queued = current.runs.find((candidate) => candidate.id === run.id);
      if (queued?.status !== "queued") continue;
      const cancelled = cancelQueuedEvents(current, queued, ctx);
      events.push(...cancelled);
      current = applyEvents(current, cancelled) ?? current;
    }

    const latest = current.thread;
    const wasPinned = latest.pinnedAt != null;
    const alreadySettled =
      latest.settledOverride === "settled" &&
      latest.settledAt !== null &&
      !wasPinned &&
      (!archiveInPlace || latest.archivedAt !== null);
    const settledAt = alreadySettled ? latest.settledAt : (command.settledAt ?? ctx.now);
    const settled = {
      ...latest,
      ...(archiveInPlace ? { archivedAt: latest.archivedAt ?? settledAt } : {}),
      settledOverride: "settled" as const,
      settledAt,
      pullRequests: latest.pullRequests?.map(({ watch: _watch, ...link }) => link),
      unsettledAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      updatedAt: alreadySettled ? latest.updatedAt : ctx.now,
    };
    return accept([...events, threadEvent(ctx, "thread.settled", settled)]);
  }

  switch (command.type) {
    case "thread.unsettle": {
      const alreadyActive = thread.settledOverride === "active";
      return accept([
        threadEvent(ctx, "thread.unsettled", {
          ...thread,
          settledOverride: "active",
          settledAt: null,
          unsettledAt: alreadyActive ? (thread.unsettledAt ?? null) : ctx.now,
          updatedAt: alreadyActive ? thread.updatedAt : ctx.now,
        }),
      ]);
    }
    case "thread.auto-settle.set": {
      const unchanged = command.enabled === (thread.autoSettleDisabledAt == null);
      return accept([
        threadEvent(ctx, "thread.auto-settle-set", {
          ...thread,
          autoSettleDisabledAt: command.enabled ? null : (thread.autoSettleDisabledAt ?? ctx.now),
          updatedAt: unchanged ? thread.updatedAt : ctx.now,
        }),
      ]);
    }
    case "thread.pin": {
      const alreadyPinned = thread.pinnedAt != null;
      const promotes = thread.settledOverride === "settled" || thread.snoozedUntil != null;
      return accept([
        threadEvent(ctx, "thread.pinned", {
          ...thread,
          pinnedAt: alreadyPinned ? thread.pinnedAt : ctx.now,
          ...(alreadyPinned || command.orderKey === undefined
            ? {}
            : { pinOrderKey: command.orderKey }),
          settledOverride: thread.settledOverride === "settled" ? "active" : thread.settledOverride,
          settledAt: thread.settledOverride === "settled" ? null : thread.settledAt,
          snoozedUntil: null,
          snoozedAt: null,
          lastSnoozeWakeAt: thread.snoozedUntil == null ? thread.lastSnoozeWakeAt : ctx.now,
          updatedAt: alreadyPinned && !promotes ? thread.updatedAt : ctx.now,
        }),
      ]);
    }
    case "thread.unpin": {
      const alreadyUnpinned = thread.pinnedAt == null;
      return accept([
        threadEvent(ctx, "thread.unpinned", {
          ...thread,
          pinnedAt: null,
          pinOrderKey: null,
          updatedAt: alreadyUnpinned ? thread.updatedAt : ctx.now,
        }),
      ]);
    }
    case "thread.pin.reorder": {
      if (thread.pinnedAt == null) {
        return reject(`Thread ${command.threadId} is not pinned and cannot be reordered.`);
      }
      const unchanged = thread.pinOrderKey === command.orderKey;
      return accept([
        threadEvent(ctx, "thread.pin-reordered", {
          ...thread,
          pinOrderKey: command.orderKey,
          updatedAt: unchanged ? thread.updatedAt : ctx.now,
        }),
      ]);
    }
    default:
      return undefined;
  }
}
