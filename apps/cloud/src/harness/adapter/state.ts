import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Deferred from "effect/Deferred";

import type { HarnessError } from "../Harness.ts";
import type { FileCommitReceipt } from "../../kernel/FilePersistencePorts.ts";

export interface ActiveTurn {
  readonly input: RunnerTurn;
  readonly began: Deferred.Deferred<void, HarnessError>;
  readonly started: Deferred.Deferred<void, HarnessError>;
  providerThread: OrchestrationV2ProviderThread;
  nativeTurn: OrchestrationV2ProviderTurn | undefined;
  nextItemOrdinal: number;
  interruptRequested: boolean;
  interruptApplied: boolean;
  readonly requests: Map<string, OrchestrationV2RuntimeRequest>;
  readonly answered: Set<string>;
  readonly steered: Set<string>;
}

export interface TurnState {
  active: ActiveTurn | undefined;
  last: ActiveTurn | undefined;
  providerThread: OrchestrationV2ProviderThread | undefined;
  revision: FileCommitReceipt | undefined;
}

/** Rows with an explicit owner must never inherit whichever run happens to be active. */
export const belongsToTurn = (event: ProviderAdapterV2Event, active: ActiveTurn): boolean => {
  const { input, providerThread, nativeTurn } = active;
  switch (event.type) {
    case "continuation.associated":
      return (
        event.association.threadId === input.threadId &&
        event.association.runId === input.runId &&
        event.association.messageId === input.message.messageId &&
        event.association.providerContinuation.providerThreadId === providerThread.id &&
        event.association.providerContinuation.sourceRunId ===
          input.message.providerContinuation?.sourceRunId
      );

    case "app_thread.created":
      return event.appThread.id === input.threadId;
    case "provider_session.updated":
      return (
        event.providerSession.id === providerThread.providerSessionId &&
        event.providerSession.providerInstanceId === providerThread.providerInstanceId
      );
    case "provider_thread.updated":
      return (
        event.providerThread.id === providerThread.id &&
        event.providerThread.appThreadId === input.threadId &&
        event.providerThread.providerInstanceId === providerThread.providerInstanceId &&
        event.providerThread.providerSessionId === providerThread.providerSessionId
      );
    case "provider_turn.updated":
      return (
        event.providerTurn.providerThreadId === providerThread.id &&
        event.providerTurn.runAttemptId === input.attemptId &&
        event.providerTurn.nodeId === input.rootNodeId &&
        (nativeTurn === undefined ||
          event.providerTurn.ordinal > nativeTurn.ordinal ||
          (event.providerTurn.ordinal === nativeTurn.ordinal &&
            event.providerTurn.id === nativeTurn.id))
      );
    case "turn.terminal":
      return (
        event.providerThreadId === providerThread.id &&
        event.providerTurnId === nativeTurn?.id &&
        event.runOrdinal === input.runOrdinal
      );
    case "runtime_request.updated":
      return (
        (event.threadId === undefined || event.threadId === input.threadId) &&
        nativeTurn !== undefined &&
        event.runtimeRequest.providerTurnId === nativeTurn.id
      );
    case "command_output.delta":
      return event.threadId === input.threadId;
    case "turn_item.updated":
      return (
        event.turnItem.threadId === input.threadId &&
        (event.turnItem.runId === null || event.turnItem.runId === input.runId) &&
        (event.turnItem.providerThreadId === null ||
          event.turnItem.providerThreadId === providerThread.id) &&
        (event.turnItem.providerTurnId === null || event.turnItem.providerTurnId === nativeTurn?.id)
      );
    case "message.updated":
      return (
        event.message.threadId === input.threadId &&
        (event.message.runId === null || event.message.runId === input.runId)
      );
    case "node.updated":
      return (
        event.node.threadId === input.threadId &&
        (event.node.runId === null || event.node.runId === input.runId)
      );
    case "subagent.updated":
      return (
        event.subagent.threadId === input.threadId &&
        (event.subagent.runId === null || event.subagent.runId === input.runId)
      );
    case "plan.updated":
      return (
        event.plan.threadId === input.threadId &&
        (event.plan.runId === null || event.plan.runId === input.runId)
      );
  }
};
