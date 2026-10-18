import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  CollaborationInput,
  CollaborationMethod,
  CollaborationOutput,
} from "@t3tools/contracts/signalboxCollaboration";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { threadShellFromProjection as threadShell } from "../thread/threadProjection.ts";
import * as ThreadInbox from "../thread/ThreadInbox.ts";
import { UserShell } from "../user/UserShell.ts";
import { activeRun, isTerminalRunStatus, isRunWaitBoundary } from "../thread/runLifecycle.ts";
import { isLiveRun } from "../thread/runState.ts";
import { makeAccess, refuse } from "./access.ts";
import { listItem, readPage } from "./threadReads.ts";
import { makeCapabilities } from "./capabilities.ts";
import { makeTasks } from "./tasks.ts";
import { stopRunCommand } from "./stopCommand.ts";
import { makeTaskRecords } from "./taskRecords.ts";
import { CollaborationError } from "./errors.ts";
import { latestLogicalRun, runContinuationChain, runOrigin } from "../thread/runContinuations.ts";

export class CloudCollaboration extends Context.Service<
  CloudCollaboration,
  {
    readonly [M in CollaborationMethod]: (
      sourceThreadId: ThreadId,
      input: CollaborationInput<M>,
    ) => Effect.Effect<CollaborationOutput<M>, CollaborationError>;
  } & {
    readonly stopDescendants: (
      parentThreadId: ThreadId,
      parentOrdinal: number,
    ) => Effect.Effect<void, CollaborationError>;
    readonly completion: <A, E, R>(
      childThreadId: ThreadId,
      childOrdinal: number,
      deliver: (disposition: {
        readonly allowed: boolean;
        readonly parentOrdinal: number | null;
      }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CollaborationError, R>;
  }
>()("@signalbox/cloud/collaboration/CloudCollaboration") {}

const latestRun = (projection: OrchestrationV2ThreadProjection) =>
  latestLogicalRun(projection.runs);
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const make = Effect.gen(function* () {
  const access = yield* makeAccess;
  const crypto = yield* Crypto.Crypto;
  const shellService = yield* UserShell;
  const inbox = yield* ThreadInbox.ThreadInbox;
  const records = yield* makeTaskRecords;

  /** A retry keeps its command and message ids, including after its first run finishes. */
  const key = (sourceThreadId: ThreadId, operation: string, requestId: string | undefined) =>
    Effect.gen(function* () {
      const request = requestId ?? (yield* Effect.orDie(crypto.randomUUIDv4()));
      return yield* Effect.orDie(
        crypto
          .digest(
            "SHA-256",
            new TextEncoder().encode(encodeKey([sourceThreadId, operation, request])),
          )
          .pipe(Effect.map(Hex.encode)),
      );
    });

  const read: CloudCollaboration["Service"]["read"] = (source, input) =>
    Effect.gen(function* () {
      const { projection } = yield* access.read(source, input.threadId);
      if (projection.thread.deletedAt !== null)
        return yield* refuse("Thread not found.", "thread_not_found");
      if (
        input.itemId !== undefined &&
        !projection.turnItems.some((item) => item.id === input.itemId)
      )
        return yield* refuse("Timeline item not found.", "thread_not_found");
      return readPage(projection, input, yield* Clock.currentTimeMillis);
    });

  const list: CloudCollaboration["Service"]["list"] = (source, input) =>
    Effect.gen(function* () {
      const caller = yield* access.source(source);
      const projectId = input.projectId ?? caller.projection.thread.projectId;
      const shell = yield* shellService.snapshot.pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(CollaborationError.unavailable("list_threads", cause)),
        }),
      );
      const now = yield* Clock.currentTimeMillis;
      const candidates = shell.threads.filter(
        (thread) =>
          thread.projectId === projectId && thread.archivedAt === null && thread.deletedAt === null,
      );
      // Recheck the authoritative object before returning even a title or a count.
      const visible = yield* Effect.forEach(
        candidates,
        (thread) =>
          access.read(source, thread.id).pipe(
            Effect.map(({ projection }) => listItem(threadShell(projection), now)),
            Effect.catchIf(
              (error) => error.code === "thread_not_found",
              () => Effect.succeed(null),
            ),
          ),
        { concurrency: 4 },
      );
      const matching = visible
        .filter(
          (thread) =>
            thread !== null &&
            (input.statuses === undefined || input.statuses.includes(thread.status)) &&
            (input.titleContains === undefined ||
              thread.title.toLowerCase().includes(input.titleContains.toLowerCase())) &&
            (input.includeSubagents === true || thread.relationshipToParent !== "subagent") &&
            (input.settled === undefined || thread.settled === input.settled) &&
            (input.snoozed === undefined || thread.snoozed === input.snoozed),
        )
        .filter((thread) => thread !== null)
        .toSorted(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.threadId.localeCompare(b.threadId),
        );
      const cursor = input.cursor ?? 0;
      const page = matching.slice(cursor, cursor + (input.limit ?? 50));
      return {
        projectId,
        currentThreadId: source,
        threads: page,
        total: matching.length,
        nextCursor: cursor + page.length < matching.length ? cursor + page.length : null,
      };
    });

  const send: CloudCollaboration["Service"]["send"] = (source, input) =>
    Effect.gen(function* () {
      const { caller, projection } = yield* access.read(source, input.threadId);
      yield* access.writable(caller.projection, projection);
      const parentRun = activeRun(caller.projection) ?? latestRun(caller.projection);
      const parentOrdinal = runOrigin(caller.projection.runs, parentRun)?.ordinal ?? 0;
      const ownedChild =
        projection.thread.lineage.relationshipToParent === "subagent" &&
        projection.thread.lineage.parentThreadId === source;
      if (
        !(yield* records.canDelegate(source, parentOrdinal)) ||
        (ownedChild && parentRun?.status === "interrupted")
      )
        return yield* refuse("This task was stopped. Start a new turn before sending work.");
      if (input.mode === "restart")
        return yield* refuse(
          "Restart isn't available in cloud collaboration yet. Interrupt the run, then send a new message.",
        );
      const operation = yield* key(source, `send:${input.threadId}`, input.clientRequestId);
      const messageId = MessageId.make(`message:${operation}`);
      const receipt = yield* inbox
        .post(caller.actor, {
          type: "message.dispatch",
          commandId: CommandId.make(`collaboration:${operation}`),
          threadId: input.threadId,
          messageId,
          text: input.message,
          attachments: [],
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: source,
          dispatchMode:
            input.mode === "queue" ? { type: "queue_after_active" } : { type: "start_immediately" },
          deliveryIntent: input.mode === "steer" ? "steer" : "auto",
        })
        .pipe(
          Effect.catchTags({
            ThreadInboxError: (cause) =>
              Effect.fail(CollaborationError.fromInbox("send_message", cause)),
          }),
        );
      if (ownedChild && parentRun !== undefined) {
        const updated = yield* access.read(source, input.threadId);
        const childRun = updated.projection.runs.find((run) => run.id === receipt.runId);
        if (childRun !== undefined)
          yield* records.recordRun(source, parentOrdinal, input.threadId, childRun.ordinal);
      }
      return receipt;
    }).pipe(records.lock.withPermits(1));

  const wait: CloudCollaboration["Service"]["wait"] = (source, input) =>
    Effect.gen(function* () {
      const first = yield* access.read(source, input.threadId);
      if (first.projection.thread.deletedAt !== null)
        return yield* refuse("Thread not found.", "thread_not_found");
      const runId = input.runId ?? latestRun(first.projection)?.id;
      if (input.runId !== undefined && !first.projection.runs.some((run) => run.id === input.runId))
        return yield* refuse("Run not found.", "run_not_found");
      const observedRun = runContinuationChain(first.projection.runs, runId).at(-1);
      if (
        source === input.threadId &&
        runId !== undefined &&
        observedRun !== undefined &&
        !isRunWaitBoundary(observedRun.status)
      )
        return yield* refuse("A thread can't wait for its own active tool call to finish.");
      const revoked = access.drives.changed.pipe(
        Stream.runForEach(() => Effect.asVoid(access.read(source, input.threadId))),
        Effect.andThen(Effect.never),
      );
      const result = yield* Effect.raceFirst(
        inbox
          .wait(first.caller.actor, {
            threadId: input.threadId,
            ...(runId === undefined ? {} : { runId }),
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            followRecovery: true,
          })
          .pipe(
            Effect.catchTags({
              ThreadInboxError: (cause) =>
                Effect.fail(CollaborationError.fromInbox("wait_for_run", cause)),
            }),
          ),
        revoked,
      );
      const after = yield* access.read(source, input.threadId);
      if (after.projection.thread.deletedAt !== null)
        return yield* refuse("Thread not found.", "thread_not_found");
      return result;
    });

  const interrupt: CloudCollaboration["Service"]["interrupt"] = (source, input) =>
    Effect.gen(function* () {
      const { caller, projection } = yield* access.read(source, input.threadId);
      yield* access.writable(caller.projection, projection);
      const run =
        input.runId === undefined
          ? projection.runs.find(isLiveRun)
          : projection.runs.find((candidate) => candidate.id === input.runId);
      if (!run) return { threadId: input.threadId, runId: null, status: "no_active_run" as const };
      if (isTerminalRunStatus(run.status))
        return { threadId: input.threadId, runId: run.id, status: run.status };
      const operation = yield* key(
        source,
        `interrupt:${input.threadId}:${run.id}`,
        input.clientRequestId,
      );
      yield* access.threads
        .dispatchCommand(caller.actor, stopRunCommand(CommandId.make(operation), run, input.reason))
        .pipe(
          Effect.catchTags({
            ThreadNotFoundError: (cause) =>
              Effect.fail(
                new CollaborationError({
                  code: "thread_not_found",
                  message: "Thread not found.",
                  cause,
                }),
              ),
            ThreadCommandRejectedError: (cause) =>
              Effect.fail(
                new CollaborationError({
                  code: "orchestration_error",
                  message: "The thread refused the request.",
                  operation: "interrupt_run",
                  cause,
                }),
              ),
            ThreadObjectError: (cause) =>
              Effect.fail(CollaborationError.unavailable("interrupt_run", cause)),
          }),
        );
      return { threadId: input.threadId, runId: run.id, status: "interrupt_requested" as const };
    });

  const capabilities = yield* makeCapabilities(access);
  const tasks = makeTasks({ access, inbox, key, wait, capabilities, records });
  return CloudCollaboration.of({ list, read, send, wait, interrupt, capabilities, ...tasks });
});

export const layer = Layer.effect(CloudCollaboration, make);
