// @effect-diagnostics nodeBuiltinImport:off - script revisions hash the retained bytes on the machine.
import * as NodeCrypto from "node:crypto";

import type {
  RetainedWorkflowScript,
  RunnerItem,
  WorkflowStopRequest,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  NodeId,
  OrchestrationV2ProviderThread,
  OrchestrationV2Subagent,
  RunId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";

import { readWorkflowScript } from "../../orchestration-v2/workflowScriptQuery.ts";

/** Only tasks observed on this runtime may be stopped; never substitute interruptTurn. */
export const makeRunnerWorkflows = (
  emit: (item: RunnerItem) => Effect.Effect<void>,
  read: typeof readWorkflowScript = readWorkflowScript,
  configDir?: string,
) => {
  const tasks = new Map<
    NodeId,
    {
      readonly task: OrchestrationV2Subagent;
      readonly runtime: Pick<ProviderAdapterV2SessionRuntime, "stopTask">;
      readonly providerThread: OrchestrationV2ProviderThread;
    }
  >();
  const retained = new Map<NodeId, RetainedWorkflowScript>();
  const results = new Map<string, Deferred.Deferred<boolean>>();

  const observe = (
    event: ProviderAdapterV2Event,
    runtime: Pick<ProviderAdapterV2SessionRuntime, "stopTask">,
    providerThread: OrchestrationV2ProviderThread | null,
    runId: RunId,
  ) =>
    Effect.gen(function* () {
      if (event.type !== "subagent.updated" || event.subagent.workflow === undefined) {
        return { event, script: null };
      }
      const task = { ...event.subagent, runId: event.subagent.runId ?? runId };
      if (
        providerThread !== null &&
        task.threadId === providerThread.appThreadId &&
        task.driver === event.driver &&
        providerThread.driver === task.driver &&
        task.nativeTaskRef?.driver === task.driver &&
        (task.providerThreadId === null || task.providerThreadId === providerThread.id)
      ) {
        tasks.set(task.id, { task, runtime, providerThread });
      }
      let script = retained.get(task.id);
      let captured = false;
      const path = task.workflow?.runHandles?.scriptPath;
      if (script === undefined && path !== undefined) {
        const file = yield* read({
          scriptPath: path,
          ...(configDir === undefined ? {} : { configDir }),
        }).pipe(Effect.option);
        if (file._tag === "Some") {
          script = {
            subagentId: task.id,
            runId: task.runId ?? runId,
            scriptPath: path,
            revision: NodeCrypto.createHash("sha256").update(file.value.contents).digest("hex"),
            contents: file.value.contents,
            truncated: file.value.truncated,
          };
          retained.set(task.id, script);
          captured = true;
        }
      }
      if (script === undefined) return { event: { ...event, subagent: task }, script: null };
      return {
        event: {
          ...event,
          subagent: {
            ...task,
            workflow: {
              ...task.workflow!,
              runHandles: {
                ...task.workflow?.runHandles,
                scriptPath: script.scriptPath,
                scriptRevision: script.revision,
              },
            },
          },
        },
        script: captured ? script : null,
      };
    });

  const stop = (request: WorkflowStopRequest) =>
    Effect.suspend(() => {
      const key = `${request.generation}:${request.subagentId}:${request.runId}:${request.taskId}:${request.attempt ?? 1}`;
      const report = (ok: boolean) => emit({ kind: "workflow.stopped", ...request, ok });
      const previous = results.get(key);
      if (previous !== undefined) return Deferred.await(previous).pipe(Effect.flatMap(report));
      const result = Deferred.makeUnsafe<boolean>();
      results.set(key, result);
      const known = tasks.get(request.subagentId);
      const valid =
        known !== undefined &&
        known.task.runId === request.runId &&
        known.task.nativeTaskRef?.nativeId === request.taskId &&
        known.task.origin === "provider_native" &&
        known.task.driver === "claudeAgent" &&
        known.runtime.stopTask !== undefined;
      const stopped = !valid
        ? Effect.succeed(false)
        : known.runtime.stopTask!({
            providerThread: known.providerThread,
            taskId: request.taskId,
          }).pipe(
            Effect.timeout("15 seconds"),
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          );
      return stopped.pipe(
        Effect.onExit((exit) => Deferred.succeed(result, Exit.isSuccess(exit) && exit.value)),
        Effect.flatMap(report),
      );
    });

  return { observe, stop };
};
