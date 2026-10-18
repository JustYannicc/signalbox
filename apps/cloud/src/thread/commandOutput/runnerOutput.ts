import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import { isLiveRun } from "../runLifecycle.ts";
import { runnerBatchEvents } from "../runner/runnerTurn.ts";
import type { DecisionContext } from "../threadEvents.ts";
import { applyEvents } from "../threadProjection.ts";
import { type CommandOutputDelta } from "./retainedOutput.ts";

/** Output is checked at its position in the batch, against canonical command rows. */
export function runnerOutputBatch(
  projection: OrchestrationV2ThreadProjection,
  items: ReadonlyArray<RunnerItem>,
  ctx: DecisionContext,
  steers: boolean,
) {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const commandOutput: Array<CommandOutputDelta> = [];
  const undecodable: Array<string> = [];
  let drained: ReturnType<typeof runnerBatchEvents>["drained"] = null;
  let current = projection;
  for (const item of items) {
    if (item.kind === "provider" && item.event.type === "command_output.delta") {
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
      continue;
    }
    const next = runnerBatchEvents(current, [item], ctx, steers);
    events.push(...next.events);
    undecodable.push(...next.undecodable);
    drained = next.drained ?? drained;
    if (next.outgrown !== null)
      return { events, commandOutput, undecodable, drained, outgrown: next.outgrown };
    current = applyEvents(current, next.events) ?? current;
  }
  return { events, commandOutput, undecodable, drained, outgrown: null };
}
