/**
 * Automation runs in the Pipeline's status vocabulary, so a run that needs you
 * reads the same here as a thread does in Home or the Pipeline. Passing runs
 * have no status: nothing to see.
 *
 * `automationAttention()` is the cross-surface feed: every run waiting on you
 * or failed, most urgent first. Pipeline, Home, and the rail can read it.
 */
import { THREAD_STATUS_DISPLAY, type ThreadDisplayStatus } from "../threadStatusDisplay";
import { AUTOMATIONS } from "./automationFixtures";
import type { Automation, AutomationRun } from "./automationModel";

export function runDisplayStatus(run: AutomationRun): ThreadDisplayStatus | null {
  switch (run.status) {
    case "waiting":
      return "approval";
    case "failed":
      return "failed";
    case "running":
      return "working";
    case "success":
      return null;
  }
}

/** A failure only counts until a later run of the same automation passes. */
function isCurrent(automation: Automation, run: AutomationRun) {
  return run.status !== "failed" || automation.runs[0]?.id === run.id;
}

function priority(status: ThreadDisplayStatus | null) {
  return status ? THREAD_STATUS_DISPLAY[status].priority : 0;
}

/** The most urgent current status across an automation's runs, like a Home folder row. */
export function automationDisplayStatus(automation: Automation): ThreadDisplayStatus | null {
  let best: ThreadDisplayStatus | null = null;
  for (const run of automation.runs) {
    if (!isCurrent(automation, run)) continue;
    const status = runDisplayStatus(run);
    if (priority(status) > priority(best)) best = status;
  }
  return best;
}

export interface AutomationAttentionItem {
  automation: Automation;
  run: AutomationRun;
  status: ThreadDisplayStatus;
}

/** Runs that need you (approval, or a failure not yet superseded), most urgent then newest first. */
export function automationAttention(
  automations: readonly Automation[] = AUTOMATIONS,
): AutomationAttentionItem[] {
  const items: AutomationAttentionItem[] = [];
  for (const automation of automations) {
    for (const run of automation.runs) {
      const status = runDisplayStatus(run);
      if (!status || !THREAD_STATUS_DISPLAY[status].needsYou) continue;
      if (!isCurrent(automation, run)) continue;
      items.push({ automation, run, status });
    }
  }
  return items.toSorted(
    (a, b) =>
      priority(b.status) - priority(a.status) || b.run.startedAt.localeCompare(a.run.startedAt),
  );
}
