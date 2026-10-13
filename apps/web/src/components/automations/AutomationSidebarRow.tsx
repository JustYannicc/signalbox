/**
 * One automation in the Automations panel: its name, when it runs next or
 * what starts it, and how its last run went (passing runs show nothing).
 * The chevron unfolds its recent runs; each opens as its chat. Only an
 * unfolded row subscribes to its runs, so the panel's traffic stays
 * proportional to what's on screen.
 */
import type { AutomationRunSummary } from "@t3tools/contracts";
import {
  automationSubtitle,
  entryKey,
  type AutomationEntry,
} from "@t3tools/client-runtime/automations/list";
import { runTitle } from "@t3tools/client-runtime/automations/runs";
import { runDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { automationState } from "../../state/automations";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Badge } from "../ui/badge";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { nextRunLabel } from "./automationFormat";
import { RunStatusMarker } from "./RunStatus";
import { useOpenAutomation } from "./useOpenAutomation";

const RUN_PREVIEW_COUNT = 3;

function RunRow(props: { run: AutomationRunSummary; active: boolean; onOpen: () => void }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={props.active} onClick={props.onOpen}>
        <span className="min-w-0 flex-1 truncate">{runTitle(props.run)}</span>
        <RunStatusMarker status={runDisplayStatus(props.run)} />
        <span className="shrink-0 text-xs font-normal text-sidebar-muted-foreground/60 tabular-nums">
          {formatRelativeTimeLabel(props.run.startedAt)}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function RecentRuns(props: {
  entry: AutomationEntry;
  activeRunId: string | null;
  onOpen: (runId: string) => void;
}) {
  const { environmentId, automation } = props.entry;
  useRelativeTimeTick(60_000);
  const [showAll, setShowAll] = useState(false);
  const detail = useEnvironmentQuery(
    automationState.detail({ environmentId, input: { automationId: automation.id } }),
  );
  const runs = detail.data?.runs ?? (automation.lastRun ? [automation.lastRun] : []);
  const activeIndex = runs.findIndex((run) => run.id === props.activeRunId);
  // The run on screen stays in sight even when it's past the preview.
  const expanded = showAll || activeIndex >= RUN_PREVIEW_COUNT;
  const visible = expanded ? runs : runs.slice(0, RUN_PREVIEW_COUNT);

  return (
    <ul className="flex flex-col gap-px pl-3" aria-label={`${automation.name} runs`}>
      {visible.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          active={run.id === props.activeRunId}
          onOpen={() => props.onOpen(run.id)}
        />
      ))}
      {!detail.data && !detail.error ? (
        <li className="px-2.5 py-1.5" role="status">
          <span className="sr-only">Loading runs</span>
          <Skeleton className="h-4 w-3/4" />
        </li>
      ) : null}
      {runs.length > RUN_PREVIEW_COUNT && activeIndex < RUN_PREVIEW_COUNT ? (
        <li>
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            {showAll ? "Show less" : `Show ${runs.length - RUN_PREVIEW_COUNT} more`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

export const AutomationSidebarRow = memo(function AutomationSidebarRow(props: {
  entry: AutomationEntry;
  /** This automation's page is open. */
  current: boolean;
  /** The run open on that page, if any. */
  activeRunId: string | null;
  expanded: boolean;
  onToggle: (key: string) => void;
  environmentLabel: string | null;
}) {
  const { entry } = props;
  const { automation } = entry;
  const openAutomation = useOpenAutomation();
  const open = (runId: string | null) =>
    openAutomation({ environmentId: entry.environmentId, automationId: automation.id }, runId);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const key = entryKey(entry);
  const hasRuns = automation.lastRun !== null;
  const subtitle = [
    automationSubtitle(automation, nextRunLabel(timestampFormat)),
    props.environmentLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={props.current && (!props.activeRunId || !props.expanded)}
        onClick={() => open(null)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "truncate text-sm",
                automation.enabled ? "text-sidebar-foreground" : "text-sidebar-muted-foreground",
              )}
            >
              {automation.name}
            </span>
            {automation.builtIn ? (
              <Badge variant="secondary" size="sm">
                Built-in
              </Badge>
            ) : null}
          </span>
          <span className="truncate text-xs font-normal text-sidebar-muted-foreground/70">
            {subtitle}
          </span>
        </span>
        <span className={hasRuns ? "pr-6" : undefined}>
          {automation.lastRun ? (
            <RunStatusMarker status={runDisplayStatus(automation.lastRun)} />
          ) : null}
        </span>
      </SidebarMenuButton>
      {hasRuns ? (
        <div className="absolute top-2.5 right-1">
          <SidebarHeaderIconButton
            label={props.expanded ? "Hide runs" : "Show runs"}
            aria-expanded={props.expanded}
            onClick={() => props.onToggle(key)}
          >
            <ChevronRightIcon
              className={cn("transition-transform", props.expanded && "rotate-90")}
            />
          </SidebarHeaderIconButton>
        </div>
      ) : null}
      {props.expanded && hasRuns ? (
        <RecentRuns
          entry={entry}
          activeRunId={props.current ? props.activeRunId : null}
          onOpen={(runId) => open(runId)}
        />
      ) : null}
    </SidebarMenuItem>
  );
});
