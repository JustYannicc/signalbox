import type { EnvironmentId, TimestampFormat, WorkflowDetailValue } from "@t3tools/contracts";
import { compactJson } from "@t3tools/client-runtime/automations/labels";
import * as Schema from "effect/Schema";

import { formatUpcomingTimestamp } from "../../timestampFormat";

/** A step's arguments as written: a single options object shows as itself. */
export function stepArgs(args: unknown): unknown {
  return Array.isArray(args) && args.length === 1 ? args[0] : args;
}

/** The code behind each option of a step that hasn't run: literals as values, expressions as source. */
export function detailText(detail: { readonly [key: string]: WorkflowDetailValue }): string | null {
  const entries = Object.entries(detail);
  if (entries.length === 0) return null;
  return entries
    .map(([key, value]) =>
      "expression" in value
        ? `${key}: ${value.expression}`
        : `${key}: ${compactJson(value.literal, 400)}`,
    )
    .join("\n");
}

/** "Next run tomorrow at 9:00 AM", in the user's time format. */
export function nextRunLabel(timestampFormat: TimestampFormat) {
  return (iso: string) => `Next run ${formatUpcomingTimestamp(iso, timestampFormat)}`;
}

export interface AutomationRouteTarget {
  readonly environmentId: EnvironmentId;
  readonly automationId: string;
}

/** The automation page's body: a run as its chat, the diagram, or the code. */
export const AutomationView = Schema.Literals(["run", "diagram", "code"]);
export type AutomationView = typeof AutomationView.Type;

/**
 * Navigation options for an automation page. A run opens as its chat unless
 * another view is named; without a run the diagram shows.
 */
export function automationRoute(
  target: AutomationRouteTarget,
  runId?: string | null,
  view?: AutomationView,
) {
  return {
    to: "/automations/$environmentId/$automationId",
    params: { environmentId: target.environmentId, automationId: target.automationId },
    search: {
      ...(runId ? { run: runId } : {}),
      ...(view && view !== (runId ? "run" : "diagram") ? { view } : {}),
    },
  } as const;
}
