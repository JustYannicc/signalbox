import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { DecisionContext } from "../threadEvents.ts";
import { applyEvents } from "../threadProjection.ts";
import { failRunEvents, unknownFailure } from "../runner/runnerTurn.ts";
import {
  changePreparation,
  preparationEvents,
  preparationItemAllowed,
  type PreparationState,
} from "./preparationState.ts";

const progressPreparation = (
  preparation: PreparationState,
  item: Extract<RunnerItem, { readonly kind: "preparation.progress" }>,
  ctx: DecisionContext,
): PreparationState => {
  const at = DateTime.formatIso(ctx.now);
  return {
    ...preparation,
    snapshot: {
      ...preparation.snapshot,
      sequence: preparation.snapshot.sequence + 1,
      stages: preparation.snapshot.stages.map((stage) =>
        stage.id !== item.stage
          ? stage
          : {
              ...stage,
              status: item.status,
              startedAt: stage.startedAt ?? at,
              endedAt: item.status === "running" ? null : at,
            },
      ),
    },
  };
};

export const preparationBatch = (
  projection: OrchestrationV2ThreadProjection,
  current: PreparationState | null,
  machineGeneration: number,
  items: ReadonlyArray<RunnerItem>,
  ctx: DecisionContext,
  guarded = true,
) => {
  let preparation = current;
  const forwarded: Array<RunnerItem> = [];
  const events: Array<OrchestrationV2DomainEvent> = [];
  for (const item of items) {
    if ("runId" in item && item.runId === preparation?.runId) {
      if (
        guarded &&
        (preparation.machineGeneration !== machineGeneration ||
          !preparationItemAllowed(preparation, item))
      )
        continue;
      if (item.kind === "preparation.progress") {
        if (preparation.status !== "preparing") continue;
        preparation = progressPreparation(preparation, item, ctx);
      } else if (item.kind === "preparation.ready") {
        if (preparation.status !== "preparing") continue;
        preparation = changePreparation(preparation, "handoff", ctx);
      } else if (item.kind === "preparation.cancelled" || item.kind === "preparation.failed") {
        if (
          item.kind === "preparation.failed" &&
          preparation.status !== "preparing" &&
          preparation.status !== "cancelling"
        )
          continue;
        preparation = changePreparation(
          preparation,
          item.kind === "preparation.cancelled" || preparation.status === "cancelling"
            ? "cancelled"
            : "failed",
          ctx,
        );
        const after = applyEvents(projection, events) ?? projection;
        const runId = preparation.runId;
        const run = after.runs.find((candidate) => candidate.id === runId);
        events.push(
          ...(preparation.status === "failed" &&
          item.kind === "preparation.failed" &&
          run !== undefined
            ? failRunEvents(
                after,
                run,
                unknownFailure(item.message ?? "Preparing this thread failed."),
                ctx,
                null,
                { queue: "hold" },
              )
            : preparationEvents(after, preparation, ctx)),
        );
      } else {
        if (item.kind === "turn.started") preparation = changePreparation(preparation, "done", ctx);
        if (item.kind === "turn.failed" && preparation.status !== "done")
          preparation = changePreparation(preparation, "failed", ctx);
        forwarded.push(item);
      }
    } else if (!item.kind.startsWith("preparation.")) {
      forwarded.push(item);
    }
  }
  return { preparation, items: forwarded, events };
};
