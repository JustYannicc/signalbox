/**
 * A home's automations in the Home tree (#313). Folded, they're one quiet
 * row ("2 automations"); an automation that needs you (a question waiting,
 * or its latest run failed) still gets its own row. Unfolded, each one gets
 * a row, and the one open on the page always does. A row opens the
 * automation on the run that needs you, traced on its diagram.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  automationKey,
  needsAttention,
  waitsOnYou,
} from "@t3tools/client-runtime/automations/list";
import { DISPLAY_STATUS_LABEL } from "@t3tools/client-runtime/automations/status";
import type { Automation, EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "../../../lib/utils";
import { StatusIcon } from "../../automations/RunStatus";
import { useOpenAutomation } from "../../automations/useOpenAutomation";
import { SidebarMenuItem } from "../../ui/sidebar";
import { attentionRunId, automationCountLabel } from "./automationHomes";
import { folderAutomationsAtom } from "./folderAutomationAtoms";
import type { FolderListKey } from "./folderSidebarModel";
import { LEVEL_ITEM_ROW_CLASS } from "./LevelRow";

export function useFolderAutomations(listKey: FolderListKey): ReadonlyArray<Automation> {
  return useAtomValue(folderAutomationsAtom(listKey));
}

const AutomationRow = memo(function AutomationRow(props: {
  environmentId: EnvironmentId;
  automation: Automation;
  active: boolean;
}) {
  const { environmentId, automation, active } = props;
  const openAutomation = useOpenAutomation();
  const loud = needsAttention(automation);
  const status = waitsOnYou(automation) ? "needsYou" : loud ? "failed" : null;
  const open = () => {
    const runId = attentionRunId(automation);
    openAutomation(
      { environmentId, automationId: automation.id },
      runId,
      runId ? "diagram" : undefined,
    );
  };

  return (
    <SidebarMenuItem>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={open}
        className={cn(
          LEVEL_ITEM_ROW_CLASS,
          active
            ? "bg-sidebar-row-selected text-sidebar-foreground"
            : "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          !active && (loud ? "text-sidebar-foreground" : "text-sidebar-muted-foreground/75"),
          loud && "font-medium",
        )}
      >
        <WorkflowIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
        <span className="min-w-0 flex-1 truncate">{automation.name}</span>
        {status ? (
          <>
            <StatusIcon status={status} className="size-3.5" />
            <span className="sr-only">{DISPLAY_STATUS_LABEL[status]}</span>
          </>
        ) : automation.enabled ? null : (
          <span className="shrink-0 text-sidebar-muted-foreground/60">Paused</span>
        )}
      </button>
    </SidebarMenuItem>
  );
});

/** The folded row plus whichever automations show; nothing for a home without automations. */
export function FolderAutomations(props: { environmentId: EnvironmentId; listKey: FolderListKey }) {
  const automations = useFolderAutomations(props.listKey);
  const [open, setOpen] = useState(false);
  const activeKey = useParams({
    strict: false,
    select: (params) =>
      params.environmentId && params.automationId
        ? automationKey(params.environmentId, params.automationId)
        : null,
  });
  if (automations.length === 0) return null;
  const isActive = (automation: Automation) =>
    activeKey === automationKey(props.environmentId, automation.id);
  const quiet = automations.filter((automation) => !needsAttention(automation));
  const hidden = quiet.filter((automation) => !isActive(automation));
  // Folded, the open automation still shows, so the page in front of you has its row.
  const shown = open
    ? automations
    : automations.filter((automation) => needsAttention(automation) || isActive(automation));

  return (
    <>
      {(open ? quiet : hidden).length > 0 ? (
        <SidebarMenuItem>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              LEVEL_ITEM_ROW_CLASS,
              "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
          >
            <WorkflowIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
            <span className="min-w-0 flex-1 truncate">
              {automationCountLabel(open ? automations.length : hidden.length)}
            </span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-sidebar-muted-foreground/60 transition-transform duration-150",
                open && "rotate-90",
              )}
            />
          </button>
        </SidebarMenuItem>
      ) : null}
      {shown.map((automation) => (
        <AutomationRow
          key={automation.id}
          environmentId={props.environmentId}
          automation={automation}
          active={isActive(automation)}
        />
      ))}
    </>
  );
}
