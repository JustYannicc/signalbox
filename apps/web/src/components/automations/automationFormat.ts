/** Display labels and time formatting for automations and their runs. */
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  isTriggerNode,
  type Automation,
  type AutomationRun,
  type AutomationRunTrigger,
  type NodeRunStatus,
} from "./automationModel";

export const RUN_STATUS_LABEL: Record<NodeRunStatus, string> = {
  success: "Succeeded",
  failed: "Failed",
  running: "Running",
  waiting: "Needs approval",
  skipped: "Skipped",
};

export const RUN_TRIGGER_LABEL: Record<AutomationRunTrigger, string> = {
  schedule: "Schedule",
  webhook: "Webhook",
  event: "Event",
  hook: "Hook",
  device: "Client signal",
  manual: "Manual",
};

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatClock(date: Date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    ...(date.getMinutes() === 0 ? {} : { minute: "2-digit" }),
  });
}

/** "Today 4 PM", "Tomorrow 3 AM", or "Oct 26" for anything further out. */
export function formatNextRun(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (isSameDay(date, now)) return `Today ${formatClock(date)}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (isSameDay(date, tomorrow)) return `Tomorrow ${formatClock(date)}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Task marked done", or "Task marked done +1" when several triggers start it. */
function triggerSummary(automation: Automation) {
  const triggers = automation.nodes.filter((node) => isTriggerNode(node.config));
  const first = triggers[0];
  if (!first) return automation.cadence;
  return triggers.length > 1 ? `${first.title} +${triggers.length - 1}` : first.title;
}

/** Next run for scheduled automations; the trigger for event and hook ones, plus the pass count for inline hooks. */
export function automationSubtitle(automation: Automation) {
  if (!automation.enabled) return "Paused";
  if (automation.nextRunAt) return `Next ${formatNextRun(automation.nextRunAt)}`;
  const trigger = triggerSummary(automation);
  if (automation.allowedToday === undefined) return trigger;
  return `${trigger} · ${automation.allowedToday.toLocaleString()} allowed today`;
}

export function formatRunStarted(run: AutomationRun) {
  return formatRelativeTimeLabel(run.startedAt);
}

export function formatRunTimestamp(run: AutomationRun) {
  return new Date(run.startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
