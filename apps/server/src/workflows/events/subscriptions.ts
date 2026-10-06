import {
  automationEventMatches,
  type WorkflowEventTrigger,
  type WorkflowTrigger,
} from "@t3tools/contracts";

import { automationTriggers } from "../columns.ts";
import type { AutomationRow } from "../WorkflowStore.ts";
import type { Actor } from "./candidate.ts";

/**
 * Which automations listen for which events: an in-memory index over the
 * live automations' event triggers, exact names in a map and wildcards in a
 * short list, so matching an event costs a lookup.
 */

const DEFAULT_MAX_EVENT_RUNS_PER_MINUTE = 30;

export interface Subscription {
  readonly automation: AutomationRow;
  readonly trigger: WorkflowEventTrigger;
  /** Event runs per minute before the automation's event triggers pause. */
  readonly limit: number;
}

const isEventTrigger = (trigger: WorkflowTrigger): trigger is WorkflowEventTrigger =>
  "on" in trigger;

const patternsOf = (trigger: WorkflowEventTrigger): ReadonlyArray<string> =>
  typeof trigger.on === "string" ? [trigger.on] : trigger.on;

export function buildIndex(rows: ReadonlyArray<AutomationRow>) {
  const exact = new Map<string, Subscription[]>();
  const wildcards: Array<{ readonly pattern: string; readonly sub: Subscription }> = [];
  for (const automation of rows) {
    if (automation.enabled !== 1 || automation.version === 0) continue;
    const triggers = automationTriggers(automation).filter(isEventTrigger);
    const limits = triggers.flatMap((trigger) =>
      trigger.maxRunsPerMinute === undefined ? [] : [trigger.maxRunsPerMinute],
    );
    const limit = limits.length > 0 ? Math.max(...limits) : DEFAULT_MAX_EVENT_RUNS_PER_MINUTE;
    for (const trigger of triggers) {
      const sub = { automation, trigger, limit };
      for (const pattern of patternsOf(trigger)) {
        if (pattern === "*" || pattern.endsWith(".*")) wildcards.push({ pattern, sub });
        else exact.set(pattern, [...(exact.get(pattern) ?? []), sub]);
      }
    }
  }
  return {
    empty: exact.size === 0 && wildcards.length === 0,
    lookup: (name: string): ReadonlyArray<Subscription> => [
      ...(exact.get(name) ?? []),
      ...wildcards.filter((entry) => automationEventMatches(entry.pattern, name)).map((e) => e.sub),
    ],
  };
}
export type SubscriptionIndex = ReturnType<typeof buildIndex>;

export const ACTORS: Record<NonNullable<WorkflowEventTrigger["from"]>, ReadonlyArray<Actor>> = {
  people: ["person"],
  agents: ["agent"],
  anyone: ["person", "agent"],
};

/** `where`: top-level fields equal to a literal, or to any literal in an array. */
export function whereMatches(
  where: WorkflowEventTrigger["where"],
  envelope: Readonly<Record<string, unknown>>,
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, expected]) => {
    const actual = envelope[field];
    return Array.isArray(expected) ? expected.includes(actual as never) : actual === expected;
  });
}
