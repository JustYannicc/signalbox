import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CloudThreadService } from "./CloudThreadService.ts";
import type { Actor } from "./ThreadEngine.ts";
import { applyEvents } from "./threadProjection.ts";

type Message = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type RunGuard = { readonly id: RunId; readonly status: OrchestrationV2Run["status"] } | null;

export class ThreadInboxError extends Schema.TaggedError<ThreadInboxError>()("ThreadInboxError", {
  code: Schema.Literals(["not_found", "rejected", "unavailable"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "not_found":
        return "Thread or run not found.";
      case "rejected":
        return "The thread inbox rejected the request.";
      case "unavailable":
        return "The thread inbox is unavailable. Try again.";
    }
  }
}

export interface InboxState {
  readonly threadId: ThreadId;
  /** The thread's single committed sequence, shared by messages and run transitions. */
  readonly sequence: number;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

export interface InboxReceipt {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly status: OrchestrationV2Run["status"];
  /** Current delivery state; a retry keeps the original run and may observe it starting. */
  readonly delivery: "started" | "queued" | "steered";
}

export interface InboxWait {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly sequence: number;
  readonly status: OrchestrationV2Run["status"] | "idle";
  readonly timedOut: boolean;
  /** Captured from the same sequence as the terminal transition, never a later separate read. */
  readonly result: { readonly messageId: MessageId; readonly text: string } | null;
}

/** Addressable thread inboxes. Platform routing and persistence stay behind this interface. */
export class ThreadInbox extends Context.Service<
  ThreadInbox,
  {
    readonly post: (
      actor: Actor,
      message: Message,
      expectedRun?: RunGuard,
    ) => Effect.Effect<InboxReceipt, ThreadInboxError>;
    readonly start: (
      actor: Actor,
      input: OrchestrationV2ThreadLaunchInput,
      lineage?: OrchestrationV2AppThreadLineage,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, ThreadInboxError>;
    readonly read: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<InboxState, ThreadInboxError>;
    /** Resumes the thread's own journal; no sidebar or search index participates in coordination. */
    readonly changes: (
      actor: Actor,
      threadId: ThreadId,
    ) => Stream.Stream<InboxState, ThreadInboxError>;
    readonly wait: (
      actor: Actor,
      input: { readonly threadId: ThreadId; readonly runId?: RunId; readonly timeoutMs?: number },
    ) => Effect.Effect<InboxWait, ThreadInboxError>;
  }
>()("@signalbox/cloud/thread/ThreadInbox") {}

const failure = (cause: { readonly _tag: string }) =>
  new ThreadInboxError({
    code:
      cause._tag === "ThreadNotFoundError"
        ? "not_found"
        : cause._tag === "ThreadCommandRejectedError"
          ? "rejected"
          : "unavailable",
    cause,
  });
const stateOf = (projection: OrchestrationV2ThreadProjection, sequence: number): InboxState => ({
  threadId: projection.thread.id,
  sequence,
  runs: projection.runs,
  messages: projection.messages,
});
const terminal = (status: string) =>
  !["queued", "preparing", "starting", "running"].includes(status);
const answerOf = (state: InboxState, runId: RunId | undefined, timedOut: boolean): InboxWait => {
  const run = state.runs.find((candidate) => candidate.id === runId);
  const result = state.messages.findLast(
    (message) => message.runId === runId && message.role === "assistant" && !message.streaming,
  );
  return {
    threadId: state.threadId,
    runId: runId ?? null,
    sequence: state.sequence,
    status: run?.status ?? "idle",
    timedOut,
    result: result === undefined ? null : { messageId: result.id, text: result.text },
  };
};

/** Cloud adapter over the thread's existing durable journal; it never creates another sequence. */
export const make = Effect.gen(function* () {
  const threads = yield* CloudThreadService;
  const read: ThreadInbox["Service"]["read"] = (actor, threadId) =>
    threads.threadSnapshot(actor, threadId).pipe(
      Effect.map(({ projection, snapshotSequence }) => stateOf(projection, snapshotSequence)),
      Effect.mapError(failure),
    );

  const post: ThreadInbox["Service"]["post"] = (actor, message, expectedRun) =>
    Effect.gen(function* () {
      const accepted = yield* threads
        .dispatchCommand(
          actor,
          {
            ...message,
            commandId: CommandId.make(`inbox:${message.messageId}`),
          },
          expectedRun,
        )
        .pipe(Effect.mapError(failure));
      const after = yield* read(actor, message.threadId);
      const saved = after.messages.find((candidate) => candidate.id === message.messageId);
      const run = after.runs.find((candidate) => candidate.id === saved?.runId);
      if (run === undefined)
        return yield* new ThreadInboxError({
          code: "unavailable",
        });
      return {
        threadId: message.threadId,
        messageId: message.messageId,
        runId: run.id,
        sequence: accepted.sequence,
        status: run.status,
        delivery:
          run.userMessageId !== message.messageId
            ? "steered"
            : run.status === "queued"
              ? "queued"
              : "started",
      };
    });

  const start: ThreadInbox["Service"]["start"] = (actor, input, lineage) =>
    Effect.gen(function* () {
      // Creation and delivery may retry independently. A crash between them leaves an empty,
      // addressable thread; replaying the same message then starts its first turn once.
      const { initialMessage, ...creation } = input;
      const child = yield* threads
        .launchThread(actor, creation, lineage)
        .pipe(Effect.mapError(failure));
      if (initialMessage !== undefined)
        yield* post(actor, {
          type: "message.dispatch",
          commandId: input.commandId,
          threadId: child.threadId,
          messageId: initialMessage.messageId ?? MessageId.make(`message:${input.commandId}`),
          text: initialMessage.text,
          ...(initialMessage.context === undefined ? {} : { context: initialMessage.context }),
          attachments: initialMessage.attachments,
          createdBy: lineage === undefined ? "user" : "agent",
          creationSource: input.creationSource ?? "server",
          ...(lineage?.parentThreadId == null ? {} : { senderThreadId: lineage.parentThreadId }),
          dispatchMode: { type: "queue_after_active" },
        });
      return { threadId: child.threadId };
    });

  const changes: ThreadInbox["Service"]["changes"] = (actor, threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const initial = yield* threads
          .threadSnapshot(actor, threadId)
          .pipe(Effect.mapError(failure));
        let projection: OrchestrationV2ThreadProjection | null = initial.projection;
        let sequence = initial.snapshotSequence;
        const updates = threads.subscribeThread(actor, { threadId, afterSequence: sequence }).pipe(
          Stream.map((batch) => {
            // Publish one coherent state per committed batch. A terminal event cannot outrun
            // a result message in the same commit, including after a resumed subscription.
            for (const item of batch) {
              if (item.kind === "snapshot") {
                projection = item.projection;
                sequence = item.snapshotSequence;
              } else if (item.kind === "event") {
                projection = applyEvents(projection, [item.event]);
                sequence = item.sequence;
              } else if (item.kind === "unknown-event") {
                sequence = item.sequence;
              }
            }
            return projection === null ? null : stateOf(projection, sequence);
          }),
          Stream.filter((state) => state !== null),
          Stream.mapError(failure),
        );
        return Stream.concat(
          Stream.make(stateOf(initial.projection, initial.snapshotSequence)),
          updates,
        );
      }),
    );

  const wait: ThreadInbox["Service"]["wait"] = (actor, input) =>
    Effect.gen(function* () {
      const first = yield* read(actor, input.threadId);
      const runId = input.runId ?? first.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]?.id;
      if (input.runId !== undefined && !first.runs.some((run) => run.id === input.runId))
        return yield* new ThreadInboxError({ code: "not_found" });
      const initial = answerOf(first, runId, false);
      if (runId === undefined || terminal(initial.status)) return initial;
      const duration = Number.isFinite(input.timeoutMs)
        ? Math.min(60_000, Math.max(1, input.timeoutMs!))
        : 60_000;
      const result = yield* changes(actor, input.threadId).pipe(
        Stream.map((state) => answerOf(state, runId, false)),
        Stream.filter((answer) => terminal(answer.status)),
        Stream.runHead,
        Effect.timeoutOption(duration),
      );
      if (Option.isSome(result) && Option.isSome(result.value)) return result.value.value;
      return answerOf(yield* read(actor, input.threadId), runId, true);
    });

  return ThreadInbox.of({ post, start, read, changes, wait });
});

export const layer = Layer.effect(ThreadInbox, make);
