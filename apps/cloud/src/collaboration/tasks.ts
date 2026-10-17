import {
  CommandId,
  MessageId,
  NodeId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  type OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";
import { runtimeModeWithin } from "@signalbox/automations/access";
import type { CollaborationInput } from "@t3tools/contracts/signalboxCollaboration";
import * as Effect from "effect/Effect";

import type * as ThreadInbox from "../thread/ThreadInbox.ts";
import { poolKindOfInstance } from "../thread/providerCatalog.ts";
import { activeRun, isLiveRun } from "../thread/runLifecycle.ts";
import type { TaskRecords } from "./taskRecords.ts";
import { makeTaskStops } from "./taskStops.ts";
import { collaborationFailure, refuse, type CollaborationAccess } from "./access.ts";
import type { CollaborationLifecycle, CollaborationService } from "./CloudCollaboration.ts";

const TASK_PREFIX = "cloud-task:";

const taskResult = (
  projection: OrchestrationV2ThreadProjection,
): OrchestratorMcpDelegateTaskResult => {
  const { thread } = projection;
  const run = projection.runs.toSorted((a, b) => a.ordinal - b.ordinal)[0];
  const latest = projection.runs
    .toSorted((a, b) => b.ordinal - a.ordinal)
    .find((candidate) => !isLiveRun(candidate) && candidate.status !== "queued");
  const summaryOf = (runId: string | undefined) => {
    const messages = projection.messages.filter(
      (message) => message.runId === runId && message.role === "assistant" && !message.streaming,
    );
    const error = projection.turnItems.find(
      (item) => item.runId === runId && item.type === "error",
    );
    return messages.at(-1)?.text ?? (error?.type === "error" ? error.failure.message : null);
  };
  const statusOf = (status: OrchestrationV2Run["status"]) =>
    status === "preparing" || status === "starting"
      ? ("running" as const)
      : status === "rolled_back"
        ? ("interrupted" as const)
        : status;
  const status = run === undefined ? "queued" : statusOf(run.status);
  const terminal =
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted";
  return {
    taskId: NodeId.make(`${TASK_PREFIX}${thread.id}`),
    childThreadId: thread.id,
    childRunId: run?.id ?? null,
    childNodeId: run?.rootNodeId ?? NodeId.make(`node:${thread.id}:pending`),
    status,
    workState: terminal ? "result_available" : "working",
    hasPendingChildRuns: projection.runs.some(
      (candidate) =>
        candidate.id !== run?.id && (isLiveRun(candidate) || candidate.status === "queued"),
    ),
    latestTerminalRunId: latest?.id ?? null,
    latestTerminalStatus:
      latest === undefined
        ? null
        : (statusOf(latest.status) as OrchestratorMcpDelegateTaskResult["latestTerminalStatus"]),
    latestTerminalSummary: latest === undefined ? null : summaryOf(latest.id),
    latestTerminalResultContextTransferId: null,
    providerInstanceId: run?.providerInstanceId ?? thread.providerInstanceId,
    model: run?.modelSelection.model ?? thread.modelSelection.model,
    summary: terminal ? summaryOf(run?.id) : null,
    resultContextTransferId: null,
    hasPendingQuestion: projection.runtimeRequests.some((request) => request.status === "pending"),
    waitTimedOut: false,
  };
};

export const makeTasks = (deps: {
  readonly access: CollaborationAccess;
  readonly inbox: ThreadInbox.ThreadInbox["Service"];
  readonly key: (
    source: ThreadId,
    operation: string,
    request: string | undefined,
  ) => Effect.Effect<string>;
  readonly wait: CollaborationService["wait"];
  readonly capabilities: CollaborationService["capabilities"];
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

  const status: CollaborationService["status"] = (source, input) =>
    ownedTask(source, input.taskId).pipe(Effect.map(({ projection }) => taskResult(projection)));

  const delegate: CollaborationService["delegate"] = (source, input) =>
    Effect.gen(function* () {
      const caller = yield* deps.access.source(source);
      const active = activeRun(caller.projection);
      const latest = caller.projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const ordinal = active?.ordinal ?? latest?.ordinal ?? 0;
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
        if (!(yield* deps.records.canDelegate(childId, 1)))
          return yield* status(source, { taskId: NodeId.make(`${TASK_PREFIX}${childId}`) });
        if (
          existing.projection.messages.some(
            (message) => message.id === MessageId.make(`message:${operation}`),
          )
        )
          return yield* status(source, { taskId: NodeId.make(`${TASK_PREFIX}${childId}`) });
        // Creation may have committed before the initial delivery. Retry that same message.
        yield* deps.inbox.post(caller.actor, {
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
        });
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
        yield* deps.access.folders.moveThread({ threadId: childId, folderId: caller.home });
        yield* deps.inbox.start(
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
        );
      }
      const taskId = NodeId.make(`${TASK_PREFIX}${childId}`);
      return yield* status(source, { taskId });
    }).pipe(deps.records.lock.withPermits(1), Effect.mapError(collaborationFailure));

  const delegateAndWait: CollaborationService["delegate"] = (source, input) =>
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
    }).pipe(Effect.mapError(collaborationFailure));

  const { stopRunTree, stopDescendants } = makeTaskStops(deps);

  const completion: CollaborationLifecycle["completion"] = (child, childOrdinal, deliver) =>
    Effect.gen(function* () {
      const disposition = yield* deps.records.completion(child, childOrdinal);
      return yield* deliver(disposition);
    }).pipe(deps.records.lock.withPermits(1));

  const cancel: CollaborationService["cancel"] = (source, input) =>
    Effect.gen(function* () {
      const { projection } = yield* ownedTask(source, input.taskId);
      yield* stopRunTree(
        source,
        projection.thread.id,
        Math.max(0, ...projection.runs.map((run) => run.ordinal)),
        input,
      );
      const after = yield* status(source, { taskId: input.taskId });
      const state = after.status;
      return {
        taskId: input.taskId,
        status:
          state === "completed" ||
          state === "failed" ||
          state === "cancelled" ||
          state === "interrupted"
            ? state
            : ("cancel_requested" as const),
      };
    }).pipe(Effect.mapError(collaborationFailure));
  return {
    delegate: delegateAndWait,
    status,
    cancel: (source: ThreadId, input: CollaborationInput<"cancel">) =>
      cancel(source, input).pipe(deps.records.lock.withPermits(1)),
    stopDescendants,
    completion,
  };
};
