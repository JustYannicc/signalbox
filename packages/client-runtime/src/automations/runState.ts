import {
  workflowNodeIdForStepKey,
  type AutomationRunDetail,
  type AutomationStepStatus,
} from "@t3tools/contracts";

import { morePressingStatus } from "./status.ts";

/** How one diagram node went in a run. Loops and helpers run a node many times; this sums them. */
export interface NodeRunState {
  readonly status: AutomationStepStatus;
  readonly runs: number;
  readonly failed: number;
  readonly waiting: number;
  /** The latest step for this node, for opening its thread or details. */
  readonly latestKey: string;
  readonly threadId: string | null;
}

/** Per graph node, how its steps went. */
export function nodeRunStates(
  detail: Pick<AutomationRunDetail, "steps">,
): ReadonlyMap<string, NodeRunState> {
  const states = new Map<string, NodeRunState>();
  for (const step of detail.steps) {
    const nodeId = workflowNodeIdForStepKey(step.key);
    const previous = states.get(nodeId);
    states.set(nodeId, {
      status: previous ? morePressingStatus(previous.status, step.status) : step.status,
      runs: (previous?.runs ?? 0) + 1,
      failed: (previous?.failed ?? 0) + (step.status === "failed" ? 1 : 0),
      waiting: (previous?.waiting ?? 0) + (step.status === "waiting" ? 1 : 0),
      latestKey: step.key,
      threadId: step.threadId ?? previous?.threadId ?? null,
    });
  }
  return states;
}

/** What the run recorded at one decision, loop or try node. */
export interface DecisionMark {
  /** Options taken, as arm indexes in diagram order; a try's failure path is 1. */
  readonly options: ReadonlySet<number>;
  /** How many times the node was reached. */
  readonly passes: number;
}

export type DecisionMarks = ReadonlyMap<string, DecisionMark>;

/**
 * What the run recorded per decision, loop or try node. A lone `w.when`
 * records true/false: true is option 0. Runs saved before marks existed
 * record nothing, so callers fall back to the steps around the node.
 */
export function decisionMarks(detail: Pick<AutomationRunDetail, "marks">): DecisionMarks {
  const result = new Map<string, { options: Set<number>; passes: number }>();
  for (const [key, value] of Object.entries(detail.marks)) {
    const option =
      typeof value === "number" ? value : typeof value === "boolean" ? (value ? 0 : 1) : null;
    if (option === null) continue;
    const nodeId = workflowNodeIdForStepKey(key);
    const entry = result.get(nodeId) ?? { options: new Set<number>(), passes: 0 };
    entry.options.add(option);
    entry.passes += 1;
    result.set(nodeId, entry);
  }
  return result;
}
