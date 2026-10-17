import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
} from "./orchestratorMcp.ts";

/** The runner and public API use the same inputs; only the credential names the runner's source. */
export const COLLABORATION_TOOLS = {
  orchestrator_capabilities: {
    method: "capabilities",
    input: Schema.Struct({}),
    output: OrchestratorMcpCapabilitiesResult,
    summary:
      "List the providers and models available to this thread's folder, and its inherited model and modes.",
    writes: false,
  },
  t3_thread_list: {
    method: "list",
    input: OrchestratorMcpThreadListInput,
    output: OrchestratorMcpThreadListResult,
    summary:
      "List accessible cloud threads, with status and paging. Defaults to this thread's project. Search storage is separate; titleContains only filters this list.",
    writes: false,
  },
  t3_thread_read: {
    method: "read",
    input: OrchestratorMcpThreadReadInput,
    output: OrchestratorMcpThreadReadResult,
    summary:
      "Read another cloud thread's timeline. Page with afterPosition and nextPosition; use itemId and textOffset to finish a truncated item. view=activity includes tool calls and their results.",
    writes: false,
  },
  t3_thread_send: {
    method: "send",
    input: OrchestratorMcpThreadSendInput,
    output: OrchestratorMcpThreadSendResult,
    summary:
      "Send to another cloud thread. queue waits behind its active turn; steer and auto steer when supported and otherwise queue. Reuse clientRequestId when retrying a send.",
    writes: { destructive: true, openWorld: true },
  },
  t3_thread_wait: {
    method: "wait",
    input: OrchestratorMcpThreadWaitInput,
    output: OrchestratorMcpThreadWaitResult,
    summary:
      "Wait for a cloud thread's run to finish or ask a question. timeoutMs only bounds this wait and never stops the run. The result names the run waited on.",
    writes: false,
  },
  delegate_task: {
    method: "delegate",
    input: OrchestratorMcpDelegateTaskInput,
    output: OrchestratorMcpDelegateTaskResult,
    summary:
      "Delegate a task to a cloud child thread in this thread's folder, inheriting its pool, instructions and modes. Pick target from orchestrator_capabilities. The child gets only the task prompt. Reuse clientRequestId on retries. mode=wait waits for its result; async returns its taskId for task_status or t3_thread_wait. Completion queues the original result to this parent, even with clients closed. Each child has its own cloud branch; isolation=shared is not available.",
    writes: { destructive: true, openWorld: true },
  },
  task_status: {
    method: "status",
    input: OrchestratorMcpTaskStatusInput,
    output: OrchestratorMcpDelegateTaskResult,
    summary:
      "Read a cloud child task created by this parent. Status and summary refer to its original run; later turns do not replace that result.",
    writes: false,
  },
  task_cancel: {
    method: "cancel",
    input: OrchestratorMcpTaskCancelInput,
    output: OrchestratorMcpTaskCancelResult,
    summary:
      "Stop a delegated cloud child's active and queued runs. Its original result stays readable with task_status.",
    writes: { destructive: true, openWorld: false },
  },
  t3_thread_interrupt: {
    method: "interrupt",
    input: OrchestratorMcpThreadInterruptInput,
    output: OrchestratorMcpThreadInterruptResult,
    summary:
      "Stop a cloud thread's active run, or a specific run. The same access and runtime limits apply as sending to it.",
    writes: { destructive: true, openWorld: false },
  },
} as const;

export type CollaborationTool = keyof typeof COLLABORATION_TOOLS;
export type CollaborationMethod = (typeof COLLABORATION_TOOLS)[CollaborationTool]["method"];
export type CollaborationInput<M extends CollaborationMethod> = Extract<
  (typeof COLLABORATION_TOOLS)[CollaborationTool],
  { readonly method: M }
>["input"]["Type"];
export type CollaborationOutput<M extends CollaborationMethod> = Extract<
  (typeof COLLABORATION_TOOLS)[CollaborationTool],
  { readonly method: M }
>["output"]["Type"];

const errors = Schema.Union([OrchestratorMcpFailure, EnvironmentAuthorizationError]);
const collaborationRpc = <
  const M extends CollaborationMethod,
  I extends Schema.Top,
  O extends Schema.Top,
>(
  method: M,
  input: I,
  output: O,
) =>
  Rpc.make(`signalbox.collaboration.${method}`, {
    payload: Schema.Struct({ sourceThreadId: ThreadId, input }),
    success: output,
    error: errors,
  });

export const SIGNALBOX_COLLABORATION_RPCS = [
  collaborationRpc(
    "capabilities",
    COLLABORATION_TOOLS.orchestrator_capabilities.input,
    COLLABORATION_TOOLS.orchestrator_capabilities.output,
  ),
  collaborationRpc(
    "list",
    COLLABORATION_TOOLS.t3_thread_list.input,
    COLLABORATION_TOOLS.t3_thread_list.output,
  ),
  collaborationRpc(
    "read",
    COLLABORATION_TOOLS.t3_thread_read.input,
    COLLABORATION_TOOLS.t3_thread_read.output,
  ),
  collaborationRpc(
    "send",
    COLLABORATION_TOOLS.t3_thread_send.input,
    COLLABORATION_TOOLS.t3_thread_send.output,
  ),
  collaborationRpc(
    "wait",
    COLLABORATION_TOOLS.t3_thread_wait.input,
    COLLABORATION_TOOLS.t3_thread_wait.output,
  ),
  collaborationRpc(
    "delegate",
    COLLABORATION_TOOLS.delegate_task.input,
    COLLABORATION_TOOLS.delegate_task.output,
  ),
  collaborationRpc(
    "status",
    COLLABORATION_TOOLS.task_status.input,
    COLLABORATION_TOOLS.task_status.output,
  ),
  collaborationRpc(
    "cancel",
    COLLABORATION_TOOLS.task_cancel.input,
    COLLABORATION_TOOLS.task_cancel.output,
  ),
  collaborationRpc(
    "interrupt",
    COLLABORATION_TOOLS.t3_thread_interrupt.input,
    COLLABORATION_TOOLS.t3_thread_interrupt.output,
  ),
] as const;

export const SIGNALBOX_COLLABORATION_SCOPES = {
  "signalbox.collaboration.capabilities": AuthOrchestrationReadScope,
  "signalbox.collaboration.list": AuthOrchestrationReadScope,
  "signalbox.collaboration.read": AuthOrchestrationReadScope,
  "signalbox.collaboration.send": AuthOrchestrationOperateScope,
  "signalbox.collaboration.wait": AuthOrchestrationReadScope,
  "signalbox.collaboration.delegate": AuthOrchestrationOperateScope,
  "signalbox.collaboration.status": AuthOrchestrationReadScope,
  "signalbox.collaboration.cancel": AuthOrchestrationOperateScope,
  "signalbox.collaboration.interrupt": AuthOrchestrationOperateScope,
} as const;
