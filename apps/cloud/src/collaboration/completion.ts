import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadInbox from "../thread/ThreadInbox.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { CloudCollaboration } from "./CloudCollaboration.ts";

/**
 * The child's event outbox delivers its original result to the parent even
 * with every client closed. The parent's command receipt deduplicates retries.
 */
export const deliverCompletion = (
  threadId: string,
  events: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent }>,
) =>
  Effect.gen(function* () {
    const stopEvents = events.flatMap(({ event }) =>
      event.type === "run.updated" &&
      (event.payload.status === "interrupted" || event.payload.status === "cancelled")
        ? [event.payload.ordinal]
        : [],
    );
    const terminal = events.some(
      ({ event }) =>
        event.type === "run.updated" &&
        event.payload.ordinal === 1 &&
        ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
    );
    if (!terminal && stopEvents.length === 0) return;
    const threads = yield* Effect.serviceOption(CloudThreadService);
    const drives = yield* Effect.serviceOption(UserDrives);
    if (Option.isNone(threads) || Option.isNone(drives)) return;
    const userId = yield* drives.value.userId;
    if (userId === null) return;
    const actor = { userId, contextIds: yield* drives.value.contextIds };
    const childId = ThreadId.make(threadId);
    const collaboration = yield* Effect.serviceOption(CloudCollaboration);
    if (Option.isSome(collaboration))
      for (const ordinal of stopEvents)
        yield* collaboration.value.stopDescendants(childId, ordinal);
    if (!terminal) return;
    const { projection } = yield* threads.value.threadSnapshot(actor, childId);
    const { lineage } = projection.thread;
    const parentThreadId = lineage.parentThreadId;
    if (lineage.relationshipToParent !== "subagent" || parentThreadId === null) return;
    const run = projection.runs.find((candidate) => candidate.ordinal === 1);
    if (run === undefined) return;
    const deliver = (disposition: {
      readonly allowed: boolean;
      readonly parentOrdinal: number | null;
    }) =>
      Effect.gen(function* () {
        if (!disposition.allowed) return;
        const parent = yield* threads.value.threadSnapshot(actor, parentThreadId);
        if (
          parent.projection.thread.archivedAt !== null ||
          parent.projection.thread.deletedAt !== null
        )
          return;
        const parentRun = parent.projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (parentRun?.status === "interrupted" || parentRun?.status === "cancelled") return;
        const delegatedFromRun =
          disposition.parentOrdinal === null
            ? undefined
            : parent.projection.runs.find(
                (candidate) => candidate.ordinal === disposition.parentOrdinal,
              );
        if (delegatedFromRun?.status === "interrupted" || delegatedFromRun?.status === "cancelled")
          return;
        const messages = projection.messages.filter(
          (message) =>
            message.runId === run.id && message.role === "assistant" && !message.streaming,
        );
        const summary =
          messages.at(-1)?.text ??
          `The child ended with status ${run.status}. Read its activity for details.`;
        const id = `cloud-task-result:${childId}:${run.id}`;
        const inbox = yield* ThreadInbox.make;
        yield* inbox.post(
          actor,
          {
            type: "message.dispatch",
            commandId: CommandId.make(id),
            messageId: MessageId.make(id),
            threadId: parentThreadId,
            senderThreadId: childId,
            createdBy: "agent",
            creationSource: "mcp",
            attachments: [],
            text: `Child task cloud-task:${childId} ${run.status}.\n\n${summary.slice(0, 12_000)}${summary.length > 12_000 ? "\n\nResult truncated. Read task_status for the full result." : ""}`,
            dispatchMode: { type: "queue_after_active" },
          },
          parentRun === undefined ? null : { id: parentRun.id, status: parentRun.status },
        );
      });
    if (Option.isSome(collaboration))
      yield* collaboration.value.completion(childId, run.ordinal, deliver);
    else yield* deliver({ allowed: true, parentOrdinal: null });
  }).pipe(
    // Losing access must not keep a child's outbox retrying a private result forever.
    Effect.catchTags({
      ThreadNotFoundError: () => Effect.void,
      ThreadInboxError: (error) => (error.code === "not_found" ? Effect.void : Effect.fail(error)),
    }),
  );
