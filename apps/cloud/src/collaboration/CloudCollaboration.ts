import {
  CommandId,
  MessageId,
  type OrchestratorMcpFailure,
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  applyEvents,
  threadShellFromProjection as threadShell,
} from "../thread/threadProjection.ts";
import { UserShell } from "../user/UserShell.ts";
import { isLiveRun } from "../thread/runLifecycle.ts";
import { makeAccess, collaborationFailure, refuse } from "./access.ts";
import { listItem, readPage } from "./threadReads.ts";
import { makeCapabilities } from "./capabilities.ts";
import { makeTasks } from "./tasks.ts";
import { makeTaskRecords } from "./taskRecords.ts";

export type CollaborationService = {
  readonly [M in CollaborationMethod]: (
    sourceThreadId: ThreadId,
    input: CollaborationInput<M>,
  ) => Effect.Effect<CollaborationOutput<M>, OrchestratorMcpFailure>;
};

export class CloudCollaboration extends Context.Service<CloudCollaboration, CollaborationService>()(
  "@signalbox/cloud/collaboration/CloudCollaboration",
) {}

const latestRun = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
const finished = (status: string) =>
  !["queued", "preparing", "starting", "running"].includes(status);
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const make = Effect.gen(function* () {
  const access = yield* makeAccess;
  const crypto = yield* Crypto.Crypto;
  const shellService = yield* UserShell;

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

  const read: CollaborationService["read"] = (source, input) =>
    Effect.gen(function* () {
      const { projection } = yield* access.read(source, input.threadId);
      if (
        input.itemId !== undefined &&
        !projection.turnItems.some((item) => item.id === input.itemId)
      )
        return yield* refuse("Timeline item not found.", "thread_not_found");
      return readPage(projection, input, yield* Clock.currentTimeMillis);
    });

  const list: CollaborationService["list"] = (source, input) =>
    Effect.gen(function* () {
      const caller = yield* access.source(source);
      const projectId = input.projectId ?? caller.projection.thread.projectId;
      const shell = yield* shellService.snapshot;
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
    }).pipe(Effect.mapError(collaborationFailure));

  const send: CollaborationService["send"] = (source, input) =>
    Effect.gen(function* () {
      const { caller, projection } = yield* access.read(source, input.threadId);
      yield* access.writable(caller.projection, projection);
      if (input.mode === "restart")
        return yield* refuse(
          "Restart isn't available in cloud collaboration yet. Interrupt the run, then send a new message.",
        );
      const operation = yield* key(source, `send:${input.threadId}`, input.clientRequestId);
      const messageId = MessageId.make(`message:${operation}`);
      const live = projection.runs.find(isLiveRun);
      yield* access.threads.dispatchCommand(caller.actor, {
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
      });
      const { projection: after } = yield* access.read(source, input.threadId);
      const message = after.messages.find((candidate) => candidate.id === messageId);
      const run = after.runs.find((candidate) => candidate.id === message?.runId);
      if (!run)
        return yield* refuse(
          "The thread accepted the message but its run is unavailable.",
          "orchestration_error",
        );
      return {
        threadId: input.threadId,
        messageId,
        runId: run.id,
        status: run.status,
        delivery:
          run.userMessageId !== messageId
            ? ("steered" as const)
            : live !== undefined && run.ordinal > live.ordinal
              ? ("queued" as const)
              : ("started" as const),
      };
    }).pipe(Effect.mapError(collaborationFailure));

  const wait: CollaborationService["wait"] = (source, input) =>
    Effect.gen(function* () {
      const first = yield* access.read(source, input.threadId);
      const runId = input.runId ?? latestRun(first.projection)?.id;
      if (input.runId !== undefined && !first.projection.runs.some((run) => run.id === input.runId))
        return yield* refuse("Run not found.", "thread_not_found");
      const answer = (projection: OrchestrationV2ThreadProjection, timedOut: boolean) => ({
        threadId: input.threadId,
        runId: runId ?? null,
        status: projection.runs.find((run) => run.id === runId)?.status ?? ("idle" as const),
        timedOut,
      });
      const initial = answer(first.projection, false);
      if (runId === undefined || finished(initial.status)) return initial;
      if (source === input.threadId)
        return yield* refuse("A thread can't wait for its own active tool call to finish.");
      let projection: OrchestrationV2ThreadProjection | null = first.projection;
      const changes = access.threads
        .subscribeThread(first.caller.actor, { threadId: input.threadId })
        .pipe(
          Stream.mapEffect((batch) =>
            Effect.gen(function* () {
              yield* access.read(source, input.threadId);
              for (const item of batch) {
                if (item.kind === "snapshot") projection = item.projection;
                else if (item.kind === "event") projection = applyEvents(projection, [item.event]);
              }
              return projection === null ? null : answer(projection, false);
            }),
          ),
          Stream.filter((result) => result !== null && finished(result.status)),
          Stream.runHead,
        );
      const revoked = access.drives.changed.pipe(
        Stream.runForEach(() => Effect.asVoid(access.read(source, input.threadId))),
        Effect.andThen(Effect.never),
      );
      const timeoutMs = Number.isFinite(input.timeoutMs)
        ? Math.min(60_000, Math.max(1, input.timeoutMs!))
        : 60_000;
      const result = yield* Effect.raceFirst(changes, revoked).pipe(
        Effect.timeoutOption(timeoutMs),
      );
      if (Option.isSome(result) && Option.isSome(result.value) && result.value.value !== null)
        return result.value.value;
      // Revalidate after the wait as well; revocation cannot return a cached result.
      return answer((yield* access.read(source, input.threadId)).projection, true);
    }).pipe(Effect.mapError(collaborationFailure));

  const interrupt: CollaborationService["interrupt"] = (source, input) =>
    Effect.gen(function* () {
      const { caller, projection } = yield* access.read(source, input.threadId);
      yield* access.writable(caller.projection, projection);
      const run =
        input.runId === undefined
          ? projection.runs.find(isLiveRun)
          : projection.runs.find((candidate) => candidate.id === input.runId);
      if (!run) return { threadId: input.threadId, runId: null, status: "no_active_run" as const };
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "interrupted" ||
        run.status === "cancelled" ||
        run.status === "rolled_back"
      )
        return { threadId: input.threadId, runId: run.id, status: run.status };
      const operation = yield* key(
        source,
        `interrupt:${input.threadId}:${run.id}`,
        input.clientRequestId,
      );
      yield* access.threads.dispatchCommand(
        caller.actor,
        run.status === "queued"
          ? {
              type: "queued-run.cancel",
              commandId: CommandId.make(operation),
              threadId: input.threadId,
              runId: run.id,
            }
          : {
              type: "run.interrupt",
              commandId: CommandId.make(operation),
              threadId: input.threadId,
              runId: run.id,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
      );
      return { threadId: input.threadId, runId: run.id, status: "interrupt_requested" as const };
    }).pipe(Effect.mapError(collaborationFailure));

  const capabilities = yield* makeCapabilities(access);
  const records = yield* makeTaskRecords;
  const tasks = makeTasks({ access, key, wait, interrupt, capabilities, records });
  return CloudCollaboration.of({ list, read, send, wait, interrupt, capabilities, ...tasks });
});

export const layer = Layer.effect(CloudCollaboration, make);
