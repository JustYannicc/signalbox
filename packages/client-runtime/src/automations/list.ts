import type {
  Automation,
  AutomationRunSummary,
  AutomationWaitingQuestion,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { startsFromPayloadOnly, triggerSummary } from "./triggers.ts";

/**
 * How automation lists read, order and filter, and which run actions an
 * automation offers. Every list (rail, overview, palette, phone) agrees.
 */

export interface AutomationEntry {
  readonly environmentId: EnvironmentId;
  readonly automation: Automation;
}

type Entry = { readonly automation: Automation };

/** One automation across environments, e.g. a React key or the open page. */
export const automationKey = (environmentId: string, automationId: string) =>
  `${environmentId}:${automationId}`;

export const entryKey = (entry: AutomationEntry) =>
  automationKey(entry.environmentId, entry.automation.id);

export const AutomationSortOrder = Schema.Literals(["attention", "name"]);
export type AutomationSortOrder = typeof AutomationSortOrder.Type;

/** Any of its runs, not just the latest, waits on an answer. */
export function waitsOnYou(automation: Pick<Automation, "waiting">): boolean {
  return automation.waiting.length > 0;
}

/** A question waiting on the user, or a latest run that failed. A later passing run clears a failure. */
export function needsAttention(automation: Pick<Automation, "waiting" | "lastRun">): boolean {
  return waitsOnYou(automation) || automation.lastRun?.status === "failed";
}

function urgency(automation: Pick<Automation, "waiting" | "lastRun">): number {
  if (waitsOnYou(automation)) return 2;
  return automation.lastRun?.status === "failed" ? 1 : 0;
}

function lastActivity(automation: Pick<Automation, "lastRun" | "updatedAt">): string {
  return automation.lastRun?.startedAt ?? automation.updatedAt;
}

/** Needs-you first (questions, then failures), then most recent activity; or by name. */
export function sortAutomations<T extends Entry>(
  entries: ReadonlyArray<T>,
  order: AutomationSortOrder,
): T[] {
  return [...entries].sort((left, right) => {
    const a = left.automation;
    const b = right.automation;
    if (order === "name") return a.name.localeCompare(b.name);
    return (
      urgency(b) - urgency(a) ||
      lastActivity(b).localeCompare(lastActivity(a)) ||
      a.name.localeCompare(b.name)
    );
  });
}

export function filterAutomations<T extends Entry>(
  entries: ReadonlyArray<T>,
  filter: { readonly query: string; readonly onlyNeedsYou: boolean },
): T[] {
  const query = filter.query.trim().toLowerCase();
  return entries.filter(
    ({ automation }) =>
      (!filter.onlyNeedsYou || needsAttention(automation)) &&
      (!query ||
        automation.name.toLowerCase().includes(query) ||
        (automation.description?.toLowerCase().includes(query) ?? false)),
  );
}

export interface AttentionFeed<T extends Entry> {
  /** Every waiting question, newest first. */
  readonly questions: ReadonlyArray<{
    readonly entry: T;
    readonly question: AutomationWaitingQuestion;
  }>;
  /** Automations whose latest run failed, newest failure first. */
  readonly failed: ReadonlyArray<T>;
}

export function attentionFeed<T extends Entry>(entries: ReadonlyArray<T>): AttentionFeed<T> {
  return {
    questions: entries
      .flatMap((entry) => entry.automation.waiting.map((question) => ({ entry, question })))
      .sort((left, right) => right.question.since.localeCompare(left.question.since)),
    failed: entries
      .filter((entry) => entry.automation.lastRun?.status === "failed")
      .sort((left, right) =>
        lastActivity(right.automation).localeCompare(lastActivity(left.automation)),
      ),
  };
}

/**
 * A row's second line: Paused, when it runs next, or what starts it.
 * `nextRun` words the next run in the client's own time format.
 */
export function automationSubtitle(
  automation: Pick<Automation, "enabled" | "nextRunAt" | "triggers">,
  nextRun: (iso: string) => string,
): string {
  if (!automation.enabled) return "Paused";
  if (automation.nextRunAt) return nextRun(automation.nextRunAt);
  return triggerSummary(automation.triggers);
}

export interface RunAction {
  readonly id: "run" | "replay";
  readonly title: string;
  /** For a replay: the input the shown run started with. */
  readonly input?: unknown;
}

/**
 * Run now and Replay for one automation and the run on screen. An automation
 * only webhooks or events start leads with replaying the shown run, since a
 * run without its payload means little; others lead with Run now and offer
 * the shown run's input as a second choice. With nothing to replay yet, the
 * lead falls to running without input.
 */
export function runActions(
  automation: Pick<Automation, "triggers">,
  shownRun: { readonly input: unknown } | null,
): { readonly lead: RunAction; readonly extra: RunAction | null } {
  const input = shownRun?.input ?? null;
  const replay = (title: string): RunAction =>
    input === null ? { id: "replay", title } : { id: "replay", title, input };
  if (startsFromPayloadOnly(automation)) {
    const runEmpty: RunAction = { id: "run", title: "Run now without input" };
    return shownRun
      ? { lead: replay("Replay this run"), extra: runEmpty }
      : { lead: runEmpty, extra: null };
  }
  return {
    lead: { id: "run", title: "Run now" },
    extra: input === null ? null : replay("Run again with this run's input"),
  };
}

/** Failed and cancelled runs can run again as a new run that reuses the steps that went well. */
export function canRetryRun(run: Pick<AutomationRunSummary, "status">): boolean {
  return run.status === "failed" || run.status === "cancelled";
}
