/**
 * One foldable node of the Home tree (section, team, or project). The chevron
 * folds it (so do ←/→ on the name); the avatar and name open the node's agent,
 * which is always yours, even inside a team. The row stays calm: while folded
 * it shows only how many things below need you; the avatar looks busy while
 * the agent works. On hover the end swaps to "+" and "⋯". Nodes can be dragged
 * and take drops; the name edits inline when renaming.
 */
import { ChevronRightIcon } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SupervisorAvatar } from "../../assistant/AssistantGlyphs";
import { THREAD_STATUS_DISPLAY } from "../../threadStatusDisplay";
import { SidebarMenuItem } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { mergeRollups, rollupOf, type HomeItemStatus, type StatusRollup } from "./homeStatus";
import { startHomeDrag, useHomeDropTarget, type HomeMovable } from "./homeMoves";
import { useOpenHomeAgent } from "./openHomeAgent";
import { useHomeNodeExpanded, useHomeSectionStore } from "./sectionStore";
import { RollupMarker } from "./StatusMarkers";
import type { MoveDestination } from "./useHomeSectionTree";

function RenameInput(props: { nodeKey: string; label: string }) {
  const rename = useHomeSectionStore((state) => state.rename);
  const setRenaming = useHomeSectionStore((state) => state.setRenaming);
  return (
    <input
      autoFocus
      defaultValue={props.label}
      aria-label={`Rename ${props.label}`}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => rename(props.nodeKey, event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") rename(props.nodeKey, event.currentTarget.value);
        else if (event.key === "Escape") setRenaming(null);
      }}
      className="h-6 min-w-0 flex-1 rounded-sm bg-sidebar-control-surface px-1.5 text-sm font-medium text-sidebar-foreground outline-hidden ring-1 ring-ring"
    />
  );
}

export function HomeTreeNode(props: {
  /** `section:<id>`, `project:<projectKey>`, or `team-project:<id>`; the persisted fold key. */
  nodeKey: string;
  label: string;
  agentId: string;
  /** e.g. "Northwind agent"; always yours, so copy reads "your Northwind agent". */
  agentName: string;
  agentStatus: HomeItemStatus | null;
  /** Inside a team: say out loud that the agent is still just yours. */
  inTeam?: boolean;
  /** Always-visible, clickable extra (the team's people cluster). */
  cluster?: ReactNode;
  rollup: StatusRollup;
  /** Hover actions: one "+" and one "⋯". */
  actions?: ReactNode;
  movable: HomeMovable;
  /** This node as a drop target. */
  destination: MoveDestination;
  dimmed?: boolean;
  children: ReactNode;
}) {
  const expanded = useHomeNodeExpanded(props.nodeKey);
  const renaming = useHomeSectionStore((state) => state.renamingKey === props.nodeKey);
  const openAgent = useOpenHomeAgent();
  const { dropActive, dropProps } = useHomeDropTarget(props.destination);
  const setExpanded = (next: boolean) =>
    useHomeSectionStore.getState().setNodeExpanded(props.nodeKey, next);
  const agentInfo = props.agentStatus ? THREAD_STATUS_DISPLAY[props.agentStatus] : null;
  const expression =
    props.agentStatus === "working" ? "thinking" : agentInfo?.needsYou ? "listening" : undefined;
  // The agent needing you always shows; everything below only while folded.
  const agentRollup = rollupOf([{ status: props.agentStatus }]);
  const shownRollup = expanded ? agentRollup : mergeRollups([props.rollup, agentRollup]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" && !expanded) {
      event.preventDefault();
      setExpanded(true);
    } else if (event.key === "ArrowLeft" && expanded) {
      event.preventDefault();
      setExpanded(false);
    }
  };

  return (
    <SidebarMenuItem>
      <div
        {...dropProps}
        draggable={!renaming}
        onDragStart={(event) => startHomeDrag(event, props.movable)}
        className={cn(
          "group/home-node relative flex h-8 items-center rounded-md hover:bg-sidebar-row-hover",
          dropActive && "bg-sidebar-row-hover ring-1 ring-ring",
          props.dimmed && "opacity-70",
        )}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={expanded ? `Collapse ${props.label}` : `Expand ${props.label}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex h-8 w-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground/60 hover:text-sidebar-foreground"
        >
          <ChevronRightIcon
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
        {renaming ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 pr-1">
            <SupervisorAvatar agentId={props.agentId} size={16} />
            <RenameInput nodeKey={props.nodeKey} label={props.label} />
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              delay={600}
              render={
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={`${props.label}, open your ${props.agentName}`}
                  onClick={() => openAgent(props.agentId)}
                  onKeyDown={handleKeyDown}
                  className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-1 text-left text-sm font-medium text-sidebar-muted-foreground/80 outline-hidden ring-ring hover:text-sidebar-foreground focus-visible:ring-2"
                />
              }
            >
              <SupervisorAvatar
                agentId={props.agentId}
                size={16}
                {...(expression ? { expression } : {})}
              />
              <span className="min-w-0 flex-1 truncate">{props.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="right">
              Open your {props.agentName}
              {agentInfo ? ` · ${agentInfo.label.toLowerCase()}` : ""}
              {props.inTeam ? " · only you see this conversation" : ""}
            </TooltipPopup>
          </Tooltip>
        )}
        {props.cluster}
        <span className="flex shrink-0 items-center gap-1.5 pr-1.5 group-hover/home-node:hidden group-has-data-popup-open/home-node:hidden">
          <RollupMarker rollup={shownRollup} />
        </span>
        {props.actions ? (
          <span className="hidden shrink-0 items-center pr-0.5 group-hover/home-node:flex group-has-data-popup-open/home-node:flex pointer-coarse:flex">
            {props.actions}
          </span>
        ) : null}
      </div>
      {expanded ? (
        <ul {...dropProps} className="flex flex-col gap-px pl-3">
          {props.children}
        </ul>
      ) : null}
    </SidebarMenuItem>
  );
}
