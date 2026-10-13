import type {
  AutomationRunSummary,
  AutomationStepStatus,
  WorkflowStepVerb,
} from "@t3tools/contracts";

/**
 * How a run or step reads, the same on every client. `needsYou` is a question
 * waiting on an answer; `waiting` is a timer or an outside event. Clients only
 * pick the colour and icon for each.
 */
export type AutomationDisplayStatus =
  | "working"
  | "needsYou"
  | "waiting"
  | "failed"
  | "done"
  | "cancelled";

export const DISPLAY_STATUS_LABEL: Record<AutomationDisplayStatus, string> = {
  working: "Running",
  needsYou: "Needs you",
  waiting: "Waiting",
  failed: "Failed",
  done: "Done",
  cancelled: "Cancelled",
};

const STEP_STATUS_PRIORITY: Record<AutomationStepStatus, number> = {
  waiting: 3,
  failed: 2,
  running: 1,
  succeeded: 0,
};

/** The status a group of steps shows: waiting beats failed beats running beats succeeded. */
export function morePressingStatus(
  left: AutomationStepStatus,
  right: AutomationStepStatus,
): AutomationStepStatus {
  return STEP_STATUS_PRIORITY[right] > STEP_STATUS_PRIORITY[left] ? right : left;
}

/** A run waiting on an answer reads as needing you; its status is still `running`. */
export function runDisplayStatus(
  run: Pick<AutomationRunSummary, "status" | "waitingOnYou">,
): AutomationDisplayStatus {
  switch (run.status) {
    case "running":
      return run.waitingOnYou ? "needsYou" : "working";
    case "succeeded":
      return "done";
    default:
      return run.status;
  }
}

/** Steps also wait on timers and events; only an `ask` waits on you. */
export function stepDisplayStatus(step: {
  readonly status: AutomationStepStatus;
  readonly verb: WorkflowStepVerb;
}): AutomationDisplayStatus {
  switch (step.status) {
    case "waiting":
      return step.verb === "ask" ? "needsYou" : "waiting";
    case "running":
      return "working";
    case "failed":
      return "failed";
    case "succeeded":
      return "done";
  }
}
