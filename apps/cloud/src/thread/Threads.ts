import type { SignalboxAsk, SignalboxAskAnswerCommand } from "@t3tools/contracts/signalboxAsks";
import type {
  OrchestrationV2Command,
  OrchestrationV2AppThreadLineage,
  OrchestrationV2GetWorkflowScriptInput,
  OrchestrationV2GetWorkflowScriptResult,
  OrchestrationGetWorkflowScriptError,
  OrchestrationV2StopWorkflowInput,
  OrchestrationV2StopWorkflowError,
  OrchestrationV2CommandOutputError,
  OrchestrationV2CommandOutputFrame,
  OrchestrationV2SubscribeCommandOutputInput,
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2Run,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
  WorktreeSetupSnapshot,
  WorktreeSetupCancelInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type {
  Actor,
  ThreadCommandRejectedError,
  ThreadNotFoundError,
  ThreadObjectError,
} from "./ThreadAccess.ts";

type ThreadReadError = ThreadNotFoundError | ThreadObjectError;
type ThreadError = ThreadReadError | ThreadCommandRejectedError;

export class Threads extends Context.Service<
  Threads,
  {
    readonly syncAutomationAsk: (
      actor: Actor,
      threadId: ThreadId,
      ask: SignalboxAsk,
    ) => Effect.Effect<{ readonly sequence: number }, ThreadError>;
    readonly answerAskAsAssistant: (
      actor: Actor,
      caller: ThreadId,
      command: typeof SignalboxAskAnswerCommand.Type,
    ) => Effect.Effect<{ readonly sequence: number }, ThreadError>;
    /** A missing thread id is derived from actor + command id, so retrying a launch cannot duplicate it. */
    readonly subscribePreparation: (
      actor: Actor,
      threadId: ThreadId,
    ) => Stream.Stream<WorktreeSetupSnapshot | null, ThreadReadError>;
    readonly cancelPreparation: (
      actor: Actor,
      input: WorktreeSetupCancelInput,
    ) => Effect.Effect<{ readonly cancelled: boolean }, ThreadError>;
    readonly launch: (
      actor: Actor,
      input: OrchestrationV2ThreadLaunchInput,
      lineage?: OrchestrationV2AppThreadLineage,
    ) => Effect.Effect<OrchestrationV2ThreadLaunchResult, ThreadError>;
    /** Resolves the turn's home and attachments before the serialized command/receipt commit. */
    readonly dispatch: (
      actor: Actor,
      command: OrchestrationV2Command,
      expectedRun?: Pick<OrchestrationV2Run, "id" | "status"> | null,
    ) => Effect.Effect<OrchestrationV2DispatchCommandResult, ThreadError>;
    /** Adopts a newly published drive's own thread branch, using the current authoritative home. */
    readonly refreshRemoteWorkspace: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadError>;
    readonly getWorkflowScript: (
      actor: Actor,
      input: OrchestrationV2GetWorkflowScriptInput,
    ) => Effect.Effect<
      OrchestrationV2GetWorkflowScriptResult,
      ThreadReadError | OrchestrationGetWorkflowScriptError
    >;
    readonly stopWorkflow: (
      actor: Actor,
      input: OrchestrationV2StopWorkflowInput,
    ) => Effect.Effect<void, ThreadReadError | OrchestrationV2StopWorkflowError>;
    readonly snapshot: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadBoundedSnapshot, ThreadReadError>;
    readonly history: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, ThreadReadError>;
    readonly commandOutput: (
      actor: Actor,
      input: OrchestrationV2SubscribeCommandOutputInput,
    ) => Stream.Stream<OrchestrationV2CommandOutputFrame, OrchestrationV2CommandOutputError>;
    /** Snapshot or replay, optional synchronization marker, then committed events; recovery owns the cursor. */
    readonly subscribe: (
      actor: Actor,
      input: OrchestrationV2SubscribeThreadInput,
    ) => Stream.Stream<ReadonlyArray<OrchestrationV2ThreadStreamItem>, ThreadError>;
  }
>()("@signalbox/cloud/thread/Threads") {}
