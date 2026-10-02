/**
 * PLACEHOLDER DATA helpers. Times are relative to page load so labels like
 * "Today 4 PM" stay plausible whenever the prototype is opened.
 */
import type { AutomationRun, NodeOwner, NodeRunResult } from "../automationModel";

export const NOW = new Date();
export const HOUR = 3_600_000;

export const NORTHWIND: NodeOwner = { scope: "company", label: "Northwind · company" };
export const YANNIC: NodeOwner = { scope: "personal", label: "Yannic · personal" };

export function lastDailyAt(hour: number) {
  const date = new Date(NOW);
  date.setHours(hour, 0, 0, 0);
  if (date > NOW) date.setDate(date.getDate() - 1);
  return date;
}
export function shiftDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}
export function lastMonthlyAt(day: number, hour: number, monthsBack: number) {
  const date = new Date(NOW.getFullYear(), NOW.getMonth(), day, hour);
  if (date > NOW) date.setMonth(date.getMonth() - 1);
  date.setMonth(date.getMonth() - monthsBack);
  return date;
}
export function lastHourly(hoursBack: number) {
  const date = new Date(NOW);
  date.setMinutes(0, 0, 0);
  return new Date(date.getTime() - hoursBack * HOUR);
}
/** Most recent `weekday` (0 = Sunday) at `hour`, `weeksBack` weeks earlier. */
export function lastWeeklyAt(weekday: number, hour: number, weeksBack: number) {
  const morning = lastDailyAt(hour);
  const back = (morning.getDay() - weekday + 7) % 7;
  return shiftDays(morning, -back - 7 * weeksBack);
}
export function hoursAgo(hours: number) {
  return new Date(NOW.getTime() - hours * HOUR);
}

export const ok = (durationMs: number, output?: unknown, input?: unknown): NodeRunResult => ({
  status: "success",
  durationMs,
  ...(input === undefined ? {} : { input }),
  ...(output === undefined ? {} : { output }),
});
export const failed = (durationMs: number, error: string, input?: unknown): NodeRunResult => ({
  status: "failed",
  durationMs,
  error,
  ...(input === undefined ? {} : { input }),
});
export const skipped: NodeRunResult = { status: "skipped" };
export const waiting = (input?: unknown): NodeRunResult => ({
  status: "waiting",
  ...(input === undefined ? {} : { input }),
});

export function run(
  id: string,
  title: string,
  startedAt: Date,
  nodes: Record<string, NodeRunResult>,
  trigger: AutomationRun["trigger"] = "schedule",
): AutomationRun {
  const results = Object.values(nodes);
  const has = (status: NodeRunResult["status"]) => results.some((node) => node.status === status);
  const status = has("failed")
    ? "failed"
    : has("waiting")
      ? "waiting"
      : has("running")
        ? "running"
        : "success";
  const durationMs =
    status === "running" || status === "waiting"
      ? null
      : results.reduce((total, node) => total + (node.durationMs ?? 0), 0);
  return { id, title, status, trigger, startedAt: startedAt.toISOString(), durationMs, nodes };
}
