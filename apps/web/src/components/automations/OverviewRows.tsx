/**
 * Pieces the `/automations` overview tabs share: a linked row (title, second
 * line, status marker) and the quiet centered message shown when a tab is empty.
 */
import type { AutomationDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { Link } from "@tanstack/react-router";

import { automationRoute, type AutomationRouteTarget } from "./automationFormat";
import { RunStatusMarker } from "./RunStatus";

export function OverviewLinkRow(props: {
  target: AutomationRouteTarget;
  /** Opens the automation on this run. */
  runId?: string;
  title: string;
  subtitle: string;
  status: AutomationDisplayStatus | null;
}) {
  return (
    <li>
      <Link
        {...automationRoute(props.target, props.runId)}
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{props.title}</span>
          <span className="truncate text-xs text-muted-foreground">{props.subtitle}</span>
        </span>
        <RunStatusMarker status={props.status} />
      </Link>
    </li>
  );
}

export function OverviewEmptyState(props: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-24 text-center">
      <p className="text-sm font-medium text-foreground">{props.title}</p>
      <p className="text-sm text-pretty text-muted-foreground">{props.description}</p>
    </div>
  );
}

export const NO_AUTOMATIONS_HINT = "Ask an agent in any thread to automate something.";
