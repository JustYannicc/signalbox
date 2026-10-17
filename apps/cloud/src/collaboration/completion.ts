import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadInbox from "../thread/ThreadInbox.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { CloudCollaboration } from "./CloudCollaboration.ts";
import { runContinuationChain } from "../thread/runContinuations.ts";
import { isTerminalRunStatus } from "../thread/runLifecycle.ts";

const wasStopped = (
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run | undefined,
) =>
  run?.status === "interrupted" &&
  !projection.runs.some((candidate) => candidate.restartContinuationOfRunId === run.id);

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
      event.type === "run.updated" && event.payload.status === "interrupted" ? [event.payload] : [],
    );
    const terminal = events.some(
      ({ event }) => event.type === "run.updated" && isTerminalRunStatus(event.payload.status),
    );
    if (!terminal && stopEvents.length === 0) return;
    const threads = yield* CloudThreadService;
    const drives = yield* UserDrives;
    const userId = yield* drives.userId;
    if (userId === null) return;
    const actor = { userId, contextIds: yield* drives.contextIds };
    const childId = ThreadId.make(threadId);
    const { projection } = yield* threads.threadSnapshot(actor, childId);
    const collaboration = yield* CloudCollaboration;
    for (const run of stopEvents)
      if (wasStopped(projection, run)) yield* collaboration.stopDescendants(childId, run.ordinal);
    if (!terminal) return;
    const { lineage } = projection.thread;
    const parentThreadId = lineage.parentThreadId;
    if (lineage.relationshipToParent !== "subagent" || parentThreadId === null) return;
    const original = projection.runs.find((candidate) => candidate.ordinal === 1);
    const run = runContinuationChain(projection.runs, original).at(-1);
    if (original === undefined || run === undefined || !isTerminalRunStatus(run.status)) return;
    if (!events.some(({ event }) => event.type === "run.updated" && event.payload.id === run.id))
      return;
    const deliver = (disposition: {
      readonly allowed: boolean;
      readonly parentOrdinal: number | null;
    }) =>
      Effect.gen(function* () {
        if (!disposition.allowed) return;
        const parent = yield* threads.threadSnapshot(actor, parentThreadId);
        if (
          parent.projection.thread.archivedAt !== null ||
          parent.projection.thread.deletedAt !== null
        )
          return;
        const parentRun = parent.projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (wasStopped(parent.projection, parentRun)) return;
        const delegatedFromRun =
          disposition.parentOrdinal === null
            ? undefined
            : parent.projection.runs.find(
                (candidate) => candidate.ordinal === disposition.parentOrdinal,
              );
        if (wasStopped(parent.projection, delegatedFromRun)) return;
        const messages = projection.messages.filter(
          (message) =>
            message.runId === run.id && message.role === "assistant" && !message.streaming,
        );
        const summary =
          messages.at(-1)?.text ??
          `The child ended with status ${run.status}. Read its activity for details.`;
        const id = `cloud-task-result:${childId}:${original.id}`;
        const inbox = yield* ThreadInbox.ThreadInbox;
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
    yield* collaboration.completion(childId, original.ordinal, deliver);
  }).pipe(
    // Losing access must not keep a child's outbox retrying a private result forever.
    Effect.catchTags({
      ThreadNotFoundError: () => Effect.void,
      ThreadInboxError: (error) =>
        error.code === "not_found"
          ? Effect.void
          : error.code === "rejected"
            ? Effect.logWarning("Child result delivery was permanently refused.", { cause: error })
            : Effect.fail(error),
    }),
  );
