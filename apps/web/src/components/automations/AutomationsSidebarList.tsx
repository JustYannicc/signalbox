/**
 * Rows for the Automations sidebar panel: section headers, the expandable
 * automation item with its runs (each opens its chat), and the shared "Show
 * more" toggle. Rows carry the Pipeline's status markers; passing runs show none.
 */
import { ChevronRightIcon, ListFilterIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { THREAD_STATUS_DISPLAY } from "../threadStatusDisplay";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { type Automation } from "./automationModel";
import { automationSubtitle, formatRunStarted } from "./automationFormat";
import { automationDisplayStatus, runDisplayStatus } from "./automationStatus";
import { RunStatusMarker } from "./RunStatusMarker";
import { useAssistantName } from "./useAssistantName";
import { WorkflowAgentAvatar } from "./WorkflowAgent";

const RUN_PREVIEW_COUNT = 3;

export type SortOrder = "attention" | "name";

function urgency(automation: Automation) {
  const status = automationDisplayStatus(automation);
  return status && THREAD_STATUS_DISPLAY[status].needsYou
    ? THREAD_STATUS_DISPLAY[status].priority
    : 0;
}

/** Needs-you first (most urgent on top), then most recent activity; or by name. */
export function sortActive(automations: readonly Automation[], order: SortOrder) {
  return automations.toSorted((a, b) => {
    if (order === "name") return a.name.localeCompare(b.name);
    const lastA = a.runs[0]?.startedAt ?? "";
    const lastB = b.runs[0]?.startedAt ?? "";
    return urgency(b) - urgency(a) || lastB.localeCompare(lastA);
  });
}

export function SectionHeader(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between pr-0.5 pl-2.5 mt-3 mb-0.5">
      <h3 className="text-xs font-medium text-sidebar-muted-foreground/70">{props.children}</h3>
      {props.action}
    </div>
  );
}

export function ShowMoreButton(props: {
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={props.onToggle}
        className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        {props.expanded ? "Show less" : `Show ${props.hiddenCount} more`}
      </button>
    </li>
  );
}

export const AutomationSidebarItem = memo(function AutomationSidebarItem(props: {
  automation: Automation;
  activeAutomationId: string | null;
  activeRunId: string | null;
  expanded: boolean;
  onToggle: (automationId: string) => void;
  onOpen: (automationId: string, runId: string | null) => void;
}) {
  const { automation } = props;
  const nameText = useAssistantName();
  const [showAllRuns, setShowAllRuns] = useState(false);
  const isCurrent = props.activeAutomationId === automation.id;
  const activeRunIndex = isCurrent
    ? automation.runs.findIndex((run) => run.id === props.activeRunId)
    : -1;
  const visibleRuns =
    showAllRuns || activeRunIndex >= RUN_PREVIEW_COUNT
      ? automation.runs
      : automation.runs.slice(0, RUN_PREVIEW_COUNT);

  return (
    <SidebarMenuItem className="group/automation">
      <SidebarMenuButton
        size="lg"
        isActive={isCurrent && activeRunIndex === -1}
        onClick={() => props.onOpen(automation.id, null)}
      >
        <WorkflowAgentAvatar automation={automation} size={20} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm text-sidebar-foreground">
            {nameText(automation.name)}
          </span>
          <span className="truncate text-xs font-normal text-sidebar-muted-foreground/70">
            {automationSubtitle(automation)}
          </span>
        </span>
        <span className={automation.runs.length > 0 ? "pr-6" : undefined}>
          <RunStatusMarker status={automationDisplayStatus(automation)} />
        </span>
      </SidebarMenuButton>
      {automation.runs.length > 0 ? (
        <div className="absolute top-2.5 right-1">
          <SidebarHeaderIconButton
            label={props.expanded ? "Hide runs" : "Show runs"}
            aria-expanded={props.expanded}
            onClick={() => props.onToggle(automation.id)}
          >
            <ChevronRightIcon
              className={cn("transition-transform", props.expanded && "rotate-90")}
            />
          </SidebarHeaderIconButton>
        </div>
      ) : null}
      {props.expanded ? (
        <ul className="flex flex-col gap-px pl-3" aria-label={`${automation.name} runs`}>
          {visibleRuns.map((run) => (
            <SidebarMenuItem key={run.id}>
              <SidebarMenuButton
                isActive={isCurrent && props.activeRunId === run.id}
                onClick={() => props.onOpen(automation.id, run.id)}
              >
                <span className="min-w-0 flex-1 truncate">{nameText(run.title)}</span>
                <RunStatusMarker status={runDisplayStatus(run)} />
                <span className="shrink-0 text-xs font-normal text-sidebar-muted-foreground/60 tabular-nums">
                  {formatRunStarted(run)}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {automation.runs.length > RUN_PREVIEW_COUNT && activeRunIndex < RUN_PREVIEW_COUNT ? (
            <ShowMoreButton
              expanded={showAllRuns}
              hiddenCount={automation.runs.length - RUN_PREVIEW_COUNT}
              onToggle={() => setShowAllRuns((value) => !value)}
            />
          ) : null}
        </ul>
      ) : null}
    </SidebarMenuItem>
  );
});

/** Sort and filter for the whole panel; lives in the panel header. */
export function AutomationsFilterMenu(props: {
  sortOrder: SortOrder;
  onSortOrderChange: (order: SortOrder) => void;
  onlyNeedsYou: boolean;
  onOnlyNeedsYouChange: (value: boolean) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton label="Sort and filter">
            <ListFilterIcon />
          </SidebarHeaderIconButton>
        }
      />
      <MenuPopup side="bottom" align="end">
        <MenuGroup>
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          <MenuRadioGroup
            value={props.sortOrder}
            onValueChange={(value) =>
              props.onSortOrderChange(value === "name" ? "name" : "attention")
            }
          >
            <MenuRadioItem value="attention">Needs you, then recent</MenuRadioItem>
            <MenuRadioItem value="name">Name</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem checked={props.onlyNeedsYou} onCheckedChange={props.onOnlyNeedsYouChange}>
          Needs you
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}
