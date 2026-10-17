import {
  AutomationError,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import {
  AutomationThreads,
  type ThreadRecordField,
  type ThreadRecordFilter,
  type ThreadRecords,
} from "@signalbox/automations/host";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";

import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import { threadShellFromProjection } from "../thread/threadProjection.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserStore from "../user/UserStore.ts";
import { ThreadContexts } from "../user/threadContexts.ts";
import { isTerminalRunStatus } from "@signalbox/automations/runs";

/**
 * The user's cloud threads, as the automation engine drives them. Every call
 * acts as the user who owns this object: automations represent their owner.
 * Thread events arrive from the thread objects (`publish`), not from a live
 * stream, since each thread is its own object.
 */

const isAutomationError = Schema.is(AutomationError);

const hostError =
  (what: string) =>
  (cause: { readonly message: string }): AutomationError =>
    new AutomationError({ message: `${what}: ${cause.message}`, cause });

/** Feeds the engine's domain event stream; `CloudAutomations.threadEvents` publishes into it. */
export class ThreadEventFeed extends Context.Service<
  ThreadEventFeed,
  {
    readonly publish: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => Effect.Effect<void>;
    readonly events: Stream.Stream<OrchestrationV2DomainEvent>;
  }
>()("@signalbox/cloud/automations/cloudThreads/ThreadEventFeed") {}

export const layerEventFeed = Layer.effect(
  ThreadEventFeed,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    return ThreadEventFeed.of({
      publish: (events) => PubSub.publishAll(pubsub, events).pipe(Effect.asVoid),
      events: Stream.fromPubSub(pubsub),
    });
  }),
);

/** The records of `projection` the engine asked for, narrowed like the server's projection store. */
export const recordsOf = <K extends ThreadRecordField>(
  projection: OrchestrationV2ThreadProjection,
  fields: ReadonlyArray<K>,
  filter: ThreadRecordFilter = {},
): ThreadRecords<K> => {
  const records: Record<string, unknown> = { thread: projection.thread };
  for (const field of fields) {
    if (field === "runs") records.runs = projection.runs;
    if (field === "messages")
      records.messages = projection.messages.filter(
        (message) =>
          (filter.messageRoles === undefined || filter.messageRoles.includes(message.role)) &&
          (filter.messageRunIds === undefined ||
            (message.runId !== null && filter.messageRunIds.includes(message.runId))),
      );
    if (field === "turnItems")
      records.turnItems = projection.turnItems.filter(
        (item) =>
          (filter.turnItemRunId === undefined || item.runId === filter.turnItemRunId) &&
          (filter.turnItemTypes === undefined || filter.turnItemTypes.includes(item.type)),
      );
  }
  return records as ThreadRecords<K>;
};

/** The user who owns this object: automations act as them. */
export const ownerActor: Effect.Effect<
  Actor,
  AutomationError,
  UserStore.UserStore | UserDrives.UserDrives
> = Effect.gen(function* () {
  const profile = yield* UserStore.UserStore.use((store) => store.profile);
  if (profile === null)
    return yield* new AutomationError({ message: "This account has no profile yet." });
  const contextIds = yield* UserDrives.UserDrives.use((drives) => drives.contextIds);
  return { userId: profile.id, contextIds };
}).pipe(
  Effect.mapError((cause) =>
    isAutomationError(cause) ? cause : hostError("Couldn't read the account")(cause),
  ),
);

export const layer = Layer.effect(
  AutomationThreads,
  Effect.gen(function* () {
    const threads = yield* CloudThreadService.CloudThreadService;
    const directory = yield* ThreadDirectory.ThreadDirectory;
    const store = yield* UserStore.UserStore;
    const drives = yield* UserDrives.UserDrives;
    const feed = yield* ThreadEventFeed;
    const contexts = yield* ThreadContexts;

    const owner = ownerActor.pipe(
      Effect.provideService(UserStore.UserStore, store),
      Effect.provideService(UserDrives.UserDrives, drives),
    );

    const projection = (threadId: ThreadId) =>
      owner.pipe(
        Effect.flatMap((actor) => threads.threadSnapshot(actor, threadId)),
        Effect.map((snapshot) => snapshot.projection),
      );

    return AutomationThreads.of({
      getThreadShell: (threadId) =>
        projection(threadId).pipe(
          Effect.map(threadShellFromProjection),
          Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          Effect.mapError(hostError("Couldn't read the thread")),
        ),
      getThreadRecords: (threadId, fields, filter) =>
        projection(threadId).pipe(
          Effect.map((read) => recordsOf(read, fields, filter)),
          Effect.mapError(hostError("Couldn't read the thread")),
        ),
      initialModelSelection: (projectId) => contexts.initialModelSelection(projectId),
      launch: (input) =>
        owner.pipe(
          Effect.flatMap((actor) =>
            threads.launchThread(actor, {
              commandId: input.commandId,
              creationSource: "server",
              projectId: input.projectId,
              title: input.title,
              generateTitle: false,
              ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              workspaceStrategy: input.workspace,
              initialMessage: { ...input.message, attachments: [] },
            }),
          ),
          Effect.map(({ threadId }) => ({ threadId })),
          Effect.mapError(hostError("Couldn't start the thread")),
        ),
      send: (input) =>
        Effect.gen(function* () {
          const actor = yield* owner;
          yield* threads.dispatchCommand(actor, {
            type: "message.dispatch",
            commandId: input.commandId,
            threadId: input.threadId,
            messageId: input.messageId,
            text: input.text,
            attachments: input.attachments,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            dispatchMode: { type: "queue_after_active" },
          });
          // The cloud picks start or queue itself; the run is the one this message asked for.
          const { runs } = yield* projection(input.threadId);
          const run = runs.find((candidate) => candidate.userMessageId === input.messageId);
          if (!run)
            return yield* new AutomationError({
              message: "The thread took the message but made no run for it.",
            });
          return { run };
        }).pipe(
          Effect.mapError((cause) =>
            isAutomationError(cause) ? cause : hostError("Couldn't send to the thread")(cause),
          ),
        ),
      interrupt: (input) =>
        Effect.gen(function* () {
          const actor = yield* owner;
          const { runs } = (yield* threads.threadSnapshot(actor, input.threadId)).projection;
          const active = runs.find((run) => !isTerminalRunStatus(run.status));
          if (!active) return;
          yield* threads.dispatchCommand(actor, {
            type: "run.interrupt",
            commandId: input.commandId,
            threadId: input.threadId,
            runId: active.id,
            reason: input.reason,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isAutomationError(cause) ? cause : hostError("Couldn't stop the thread")(cause),
          ),
        ),
      // Cloud threads aren't settled by automations yet; a model step's thread stays in the list.
      settle: () => Effect.void,
      domainEvents: feed.events,
      monitorsChanged: (threadId, monitors) =>
        owner.pipe(
          Effect.flatMap((actor) =>
            directory.forThread(threadId as ThreadId).setMonitors(actor, monitors),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("attached runs couldn't reach the thread", { threadId, cause }),
          ),
        ),
    });
  }),
);
