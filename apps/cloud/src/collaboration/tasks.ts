import { CommandId, MessageId, NodeId, ThreadId } from "@t3tools/contracts";
import { runtimeModeWithin } from "@signalbox/automations/access";
import type {
  CollaborationInput,
  CollaborationOutput,
} from "@t3tools/contracts/signalboxCollaboration";
import * as Effect from "effect/Effect";

import type * as ThreadInbox from "../thread/ThreadInbox.ts";
import { poolKindOfInstance } from "../models/ModelRouting.ts";
import { activeRun, isTerminalRunStatus } from "../thread/runLifecycle.ts";
import { latestLogicalRun, runOrigin } from "../thread/runContinuations.ts";
import type { TaskRecords } from "./taskRecords.ts";
import { makeTaskStops } from "./taskStops.ts";
import { refuse, type CollaborationAccess } from "./access.ts";
import { CollaborationError } from "./errors.ts";
import type { makeCapabilities } from "./capabilities.ts";
import { taskResult } from "./taskRuns.ts";

const TASK_PREFIX = "cloud-task:";

export const makeTasks = (deps: {
  readonly access: CollaborationAccess;
  readonly inbox: ThreadInbox.ThreadInbox["Service"];
  readonly key: (
    source: ThreadId,
    operation: string,
    request: string | undefined,
  ) => Effect.Effect<string>;
  readonly wait: (
    source: ThreadId,
    input: CollaborationInput<"wait">,
  ) => Effect.Effect<CollaborationOutput<"wait">, CollaborationError>;
  readonly capabilities: Effect.Success<ReturnType<typeof makeCapabilities>>;
  readonly records: TaskRecords;
}) => {
  const ownedTask = (source: ThreadId, taskId: string) =>
    Effect.gen(function* () {
      if (!taskId.startsWith(TASK_PREFIX))
        return yield* refuse("Task not found.", "task_not_found");
      const target = ThreadId.make(taskId.slice(TASK_PREFIX.length));
      const found = yield* deps.access.read(source, target);
      if (
        found.projection.thread.lineage.parentThreadId !== source ||
        found.projection.thread.lineage.relationshipToParent !== "subagent"
      )
        return yield* refuse("Task not found.", "task_not_found");
      return found;
    });

  const status = (
    source: ThreadId,
    input: CollaborationInput<"status">,
  ): Effect.Effect<CollaborationOutput<"status">, CollaborationError> =>
    Effect.gen(function* () {
      const { projection } = yield* ownedTask(source, input.taskId);
      if (projection.thread.deletedAt !== null)
        return yield* refuse("Task not found.", "task_not_found");
      return taskResult(projection);
    });

  const delegate = (
    source: ThreadId,
    input: CollaborationInput<"delegate">,
  ): Effect.Effect<CollaborationOutput<"delegate">, CollaborationError> =>
    Effect.gen(function* () {
      const caller = yield* deps.access.source(source);
      const active = activeRun(caller.projection);
      const latest = latestLogicalRun(caller.projection.runs);
      const sourceRun = runOrigin(caller.projection.runs, active ?? latest);
      const ordinal = sourceRun?.ordinal ?? 0;
      if (input.isolation === "shared")
        return yield* refuse(
          "Cloud child threads have their own branch. Omit isolation or use worktree.",
        );
      const operation = yield* deps.key(source, "delegate", input.clientRequestId);
      const childId = ThreadId.make(`thread:${operation}`);
      const existing = yield* deps.access.read(source, childId).pipe(
        Effect.catchIf(
          (error) => error.code === "thread_not_found",
          () => Effect.succeed(null),
        ),
      );
      if (existing !== null) {
        if (existing.projection.thread.lineage.parentThreadId !== source)
          return yield* refuse("Task not found.", "task_not_found");
        if (existing.projection.thread.deletedAt !== null)
          return yield* status(source, { taskId: NodeId.make(`${TASK_PREFIX}${childId}`) });
        if (!(yield* deps.records.canDelegate(childId, 1)))
          return yield* status(source, { taskId: NodeId.make(`${TASK_PREFIX}${childId}`) });
        if (
          existing.projection.messages.some(
            (message) => message.id === MessageId.make(`message:${operation}`),
          )
        )
          return yield* status(source, { taskId: NodeId.make(`${TASK_PREFIX}${childId}`) });
        // Creation may have committed before the initial delivery. Retry that same message.
        yield* deps.inbox
          .post(caller.actor, {
            type: "message.dispatch",
            commandId: CommandId.make(`collaboration:${operation}`),
            threadId: childId,
            messageId: MessageId.make(`message:${operation}`),
            text: input.task,
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
            senderThreadId: source,
            dispatchMode: { type: "queue_after_active" },
          })
          .pipe(
            Effect.catchTags({
              ThreadInboxError: (cause) =>
                Effect.fail(CollaborationError.fromInbox("retry_task_message", cause)),
            }),
          );
      } else {
        if (
          (active === undefined && latest?.status === "interrupted") ||
          !(yield* deps.records.canDelegate(source, ordinal))
        )
          return yield* refuse("This task was stopped. Start a new turn before delegating again.");
        const parent = caller.projection.thread;
        let modelSelection = parent.modelSelection;
        if (
          input.target !== undefined ||
          poolKindOfInstance(parent.providerInstanceId) !== undefined
        ) {
          const { providers } = yield* deps.capabilities(source, {});
          const provider = providers.find(
            (candidate) =>
              (input.target?.providerInstanceId === undefined ||
                candidate.providerInstanceId === input.target.providerInstanceId) &&
              (input.target?.driverKind === undefined ||
                candidate.driverKind === input.target.driverKind) &&
              (input.target?.providerInstanceId !== undefined ||
                input.target?.driverKind !== undefined ||
                candidate.providerInstanceId === parent.providerInstanceId),
          );
          if (provider === undefined || !provider.canRunChildTask)
            return yield* refuse(
              provider?.constraints.join(" ") || "That provider can't run a child in this folder.",
              "provider_unavailable",
            );
          const model =
            input.target?.model ??
            (provider.providerInstanceId === parent.providerInstanceId
              ? parent.modelSelection.model
              : provider.models[0]?.id);
          if (model === undefined || !provider.models.some((candidate) => candidate.id === model))
            return yield* refuse("That model isn't available in this folder.", "model_unavailable");
          modelSelection = {
            instanceId: provider.providerInstanceId,
            model,
            ...(input.target?.options !== undefined
              ? { options: input.target.options }
              : provider.providerInstanceId === parent.providerInstanceId &&
                  model === parent.modelSelection.model &&
                  parent.modelSelection.options !== undefined
                ? { options: parent.modelSelection.options }
                : {}),
          };
        }
        const runtimeMode =
          input.runtimeMode === undefined || input.runtimeMode === "inherit"
            ? parent.runtimeMode
            : input.runtimeMode;
        if (!runtimeModeWithin(runtimeMode, parent.runtimeMode))
          return yield* refuse(
            "A child can't have more access than its parent.",
            "runtime_mode_escalation_denied",
          );
        const interactionMode =
          input.interactionMode === undefined || input.interactionMode === "inherit"
            ? parent.interactionMode
            : input.interactionMode;
        if (parent.interactionMode === "plan" && interactionMode !== "plan")
          return yield* refuse(
            "A child must stay in plan mode while its parent is planning.",
            "interaction_mode_escalation_denied",
          );
        yield* deps.records.record(source, childId, ordinal);
        // File first: the very first turn must resolve the parent's complete home chain.
        yield* deps.access.folders.moveThread({ threadId: childId, folderId: caller.home }).pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(CollaborationError.unavailable("file_child_thread", cause)),
            FolderRefusedError: (cause) =>
              Effect.fail(
                new CollaborationError({
                  code: "orchestration_error",
                  message: "The thread refused the request.",
                  operation: "file_child_thread",
                  cause,
                }),
              ),
          }),
        );
        yield* deps.inbox
          .start(
            caller.actor,
            {
              commandId: CommandId.make(`collaboration:${operation}`),
              threadId: childId,
              projectId: parent.projectId,
              title: input.title ?? input.task.split("\n")[0]!.slice(0, 120),
              creationSource: "mcp",
              modelSelection,
              runtimeMode,
              interactionMode,
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: MessageId.make(`message:${operation}`),
                text: input.task,
                attachments: [],
              },
            },
            {
              parentThreadId: source,
              rootThreadId: parent.lineage.rootThreadId,
              relationshipToParent: "subagent",
            },
          )
          .pipe(
            Effect.catchTags({
              ThreadInboxError: (cause) =>
                Effect.fail(CollaborationError.fromInbox("start_child_thread", cause)),
            }),
          );
      }
      const taskId = NodeId.make(`${TASK_PREFIX}${childId}`);
      return yield* status(source, { taskId });
    }).pipe(deps.records.lock.withPermits(1));

  const delegateAndWait = (
    source: ThreadId,
    input: CollaborationInput<"delegate">,
  ): Effect.Effect<CollaborationOutput<"delegate">, CollaborationError> =>
    Effect.gen(function* () {
      const initial = yield* delegate(source, input);
      if (input.mode !== "wait" || initial.workState === "result_available") return initial;
      const waited = yield* deps.wait(source, {
        threadId: initial.childThreadId,
        ...(initial.childRunId === null ? {} : { runId: initial.childRunId }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      return {
        ...(yield* status(source, { taskId: initial.taskId })),
        waitTimedOut: waited.timedOut,
      };
    });

  const { stopRunTree, stopDescendants } = makeTaskStops(deps);

  const completion = <A, E, R>(
    child: ThreadId,
    childOrdinal: number,
    deliver: (disposition: {
      readonly allowed: boolean;
      readonly parentOrdinal: number | null;
    }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | CollaborationError, R> =>
    Effect.gen(function* () {
      const disposition = yield* deps.records.completion(child, childOrdinal);
      return yield* deliver(disposition);
    }).pipe(deps.records.lock.withPermits(1));

  const cancel = (
    source: ThreadId,
    input: CollaborationInput<"cancel">,
  ): Effect.Effect<CollaborationOutput<"cancel">, CollaborationError> =>
    Effect.gen(function* () {
      const { projection } = yield* ownedTask(source, input.taskId);
      yield* stopRunTree(
        source,
        projection.thread.id,
        Math.max(0, ...projection.runs.map((run) => run.ordinal)),
        input,
      );
      const after = yield* ownedTask(source, input.taskId);
      const state = taskResult(after.projection).status;
      return {
        taskId: input.taskId,
        status: isTerminalRunStatus(state) ? state : ("cancel_requested" as const),
      };
    });
  return {
    delegate: delegateAndWait,
    status,
    cancel: (source: ThreadId, input: CollaborationInput<"cancel">) =>
      cancel(source, input).pipe(deps.records.lock.withPermits(1)),
    stopDescendants,
    completion,
  };
};
