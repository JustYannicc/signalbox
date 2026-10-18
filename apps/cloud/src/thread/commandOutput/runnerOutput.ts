import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import type { NativeChildPending } from "../NativeChildProtocol.ts";
import { isLiveRun } from "../runState.ts";
import { runnerBatchEvents } from "../runner/runnerTurn.ts";
import type { DecisionContext } from "../threadEvents.ts";
import { type CommandOutputDelta } from "./retainedOutput.ts";

/** Output is checked at its position in the batch, against canonical command rows. */
export function runnerOutputBatch(
  projection: OrchestrationV2ThreadProjection,
  items: ReadonlyArray<RunnerItem>,
  ctx: DecisionContext,
  steers: boolean,
  pendingChildren: ReadonlyArray<NativeChildPending> = [],
) {
  const commandOutput: Array<CommandOutputDelta> = [];
  // Native child creation and attestation can span items, so mapping keeps one batch context.
  const batch = runnerBatchEvents(
    projection,
    items,
    ctx,
    steers,
    pendingChildren,
    (current, item) => {
      const { threadId, itemId, chunk } = item.event;
      const command = current.turnItems.find((candidate) => candidate.id === itemId);
      const run = current.runs.find((candidate) => candidate.id === item.runId);
      if (
        threadId === current.thread.id &&
        typeof chunk === "string" &&
        chunk.length > 0 &&
        command?.type === "command_execution" &&
        command.threadId === threadId &&
        command.runId === item.runId &&
        isOrchestrationV2WorkActive(command.status) &&
        run !== undefined &&
        run.threadId === threadId &&
        isLiveRun(run)
      ) {
        commandOutput.push({ itemId: command.id, runId: run.id, chunk });
      }
    },
  );
  return { ...batch, commandOutput };
}
