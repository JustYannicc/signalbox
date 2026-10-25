import {
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import type { TimelineLatestRun } from "./MessagesTimeline.logic";

type SettledRunInput = Pick<
  OrchestrationV2Run,
  "id" | "status" | "requestedAt" | "workStartedAt" | "startedAt" | "completedAt"
>;

const SETTLED = new Set<OrchestrationV2Run["status"]>(["completed", "interrupted", "failed"]);

/**
 * signalbox: every settled run's own status and times, so an older turn keeps
 * "You stopped after 1m 29s" once a newer turn starts instead of falling back
 * to an entry-timestamp guess. Equal summaries keep `previous`, so the
 * timeline's streaming fast path still sees the same input.
 */
export function settledRunSummaries(
  runs: ReadonlyArray<SettledRunInput>,
  previous: ReadonlyMap<RunId, TimelineLatestRun> | null,
): ReadonlyMap<RunId, TimelineLatestRun> {
  const next = new Map<RunId, TimelineLatestRun>();
  for (const run of runs) {
    if (!SETTLED.has(run.status) || run.completedAt === null) continue;
    next.set(run.id, {
      runId: run.id,
      status: run.status,
      // When the run left the queue, setup included; never the provider's later start.
      startedAt: DateTime.formatIso(orchestrationV2RunWorkStartedAt(run)),
      completedAt: DateTime.formatIso(run.completedAt),
    });
  }
  if (previous !== null && previous.size === next.size) {
    let same = true;
    for (const [id, run] of next) {
      const kept = previous.get(id);
      if (
        kept?.status !== run.status ||
        kept.startedAt !== run.startedAt ||
        kept.completedAt !== run.completedAt
      ) {
        same = false;
        break;
      }
    }
    if (same) return previous;
  }
  return next;
}

/** The thread's settled run summaries, the same map until one of them changes. */
export function useSettledRunSummaries(
  runs: ReadonlyArray<SettledRunInput>,
): ReadonlyMap<RunId, TimelineLatestRun> {
  const [latest, setLatest] = useState(() => ({
    runs,
    summaries: settledRunSummaries(runs, null),
  }));
  if (latest.runs === runs) return latest.summaries;
  const summaries = settledRunSummaries(runs, latest.summaries);
  setLatest({ runs, summaries });
  return summaries;
}
