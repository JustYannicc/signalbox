import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";

import { itemOrdinal } from "./threadEvents.ts";

/** Turn items fill a run's band from the bottom; a failure row sits at its top. */
export const ERROR_ITEM_BAND_POSITION = 999_999;

/**
 * Turn items are placed in their run's band in the order they first appear,
 * as upstream's position store does, whatever ordinal the adapter chose.
 */
export function positionTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
) {
  const existing = projection.turnItems.find((candidate) => candidate.id === item.id);
  if (existing !== undefined) return { ...item, ordinal: existing.ordinal };
  const run = projection.runs.find((candidate) => candidate.id === item.runId);
  const low = itemOrdinal(run?.ordinal ?? 0, 0);
  const high = itemOrdinal(run?.ordinal ?? 0, ERROR_ITEM_BAND_POSITION - 1);
  const last = projection.turnItems
    .map((candidate) => candidate.ordinal)
    .filter((ordinal) => ordinal >= low && ordinal <= high)
    .reduce((max, ordinal) => Math.max(max, ordinal), low);
  return { ...item, ordinal: last + 1 };
}
