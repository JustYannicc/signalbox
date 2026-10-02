/**
 * One row anatomy for every Home item: type icon (for chats and tasks, the
 * one-click Chat/Task toggle; rooms show the room icon), title, markers, then
 * the Pipeline status, or the age when nothing is going on. The harness lives
 * only in the hover details. On
 * hover: Done (tasks) or Archive, and "⋯" with Move to…. Rows recede by
 * attention (the Pipeline's rule), never by type. Rows drag into any
 * container. The title button stretches under the row so any gap opens it.
 */
import { ArchiveIcon, CheckIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { threadRowRecedes, type ThreadDisplayStatus } from "../../threadStatusDisplay";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { startHomeDrag, type HomeMovable } from "./homeMoves";
import { RowMoreMenu } from "./NodeMenus";
import { StatusMarker, WaitingOnMarker } from "./StatusMarkers";
import { chatExpiry } from "./threadKind";
import {
  ITEM_TYPE_ICON,
  ThreadKindIcon,
  type HomeItemType,
  type KindControl,
} from "./ThreadKindIcon";

const ROW_BUTTON_CLASS_NAME =
  "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-hidden after:absolute after:inset-0 after:rounded-md after:ring-ring focus-visible:after:ring-2";

function compactAge(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** Age, or on a chat's last idle day the archive countdown; the countdown is always in the tooltip. */
function AgeLabel(props: { type: HomeItemType; lastActiveAt: string }) {
  const expiry = props.type === "chat" ? chatExpiry(props.lastActiveAt) : null;
  const text = expiry?.lastDay ? expiry.label : compactAge(props.lastActiveAt);
  const label = (
    <span className="relative z-10 text-xs font-normal text-sidebar-muted-foreground/60 tabular-nums">
      {text}
    </span>
  );
  if (!expiry) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipPopup side="top">{expiry.label}</TooltipPopup>
    </Tooltip>
  );
}

export function HomeItemRow(props: {
  type: HomeItemType;
  title: string;
  isActive: boolean;
  onOpen: () => void;
  /** Chat/Task toggle; rooms have none. */
  kind?: KindControl;
  status: ThreadDisplayStatus | null;
  /** Someone other than you acts next; shown instead of the age. */
  waitingOnId?: string | null;
  /** Scope and mention markers. */
  markers?: ReactNode;
  lastActiveAt: string;
  onArchive: () => void;
  movable: HomeMovable;
  /** Where the row sits now, left out of Move to…. */
  containerKey: string;
  /** Rich hover details for real threads; anchored to the whole row. */
  details?: ReactNode;
  statusTooltip?: string;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const type: HomeItemType = props.kind ? props.kind.kind : props.type;
  const isTask = type === "task";
  const ActionIcon = isTask ? CheckIcon : ArchiveIcon;
  const TypeIcon = ITEM_TYPE_ICON[type];
  const recedes = threadRowRecedes(
    props.status ?? (props.waitingOnId ? "waiting" : null),
    props.isActive,
  );

  const titleButton = (
    <button
      type="button"
      aria-current={props.isActive ? "page" : undefined}
      onClick={props.onOpen}
      className={ROW_BUTTON_CLASS_NAME}
    />
  );

  return (
    <li
      ref={rowRef}
      draggable
      onDragStart={(event) => startHomeDrag(event, props.movable)}
      className={cn(
        "group/home-thread relative flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
        props.isActive
          ? "bg-sidebar-row-selected text-sidebar-foreground"
          : "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        recedes ? "font-normal" : "font-medium",
        !props.isActive &&
          (recedes ? "text-sidebar-muted-foreground/70" : "text-sidebar-muted-foreground"),
      )}
    >
      {props.kind ? (
        <ThreadKindIcon control={props.kind} title={props.title} />
      ) : (
        <TypeIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
      )}
      {props.details ? (
        <Tooltip>
          <TooltipTrigger render={titleButton}>
            <span className="min-w-0 flex-1 truncate">{props.title}</span>
          </TooltipTrigger>
          <TooltipPopup anchor={rowRef} side="right" align="start" sideOffset={4} variant="glass">
            {props.details}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <button
          type="button"
          aria-current={props.isActive ? "page" : undefined}
          onClick={props.onOpen}
          className={ROW_BUTTON_CLASS_NAME}
        >
          <span className="min-w-0 flex-1 truncate">{props.title}</span>
        </button>
      )}
      <span className="flex shrink-0 items-center gap-1.5 group-hover/home-thread:opacity-0 group-has-focus-visible/home-thread:opacity-0 group-has-data-popup-open/home-thread:opacity-0 pointer-coarse:opacity-100">
        {props.markers}
        {props.status ? (
          <StatusMarker
            status={props.status}
            {...(props.statusTooltip ? { tooltip: props.statusTooltip } : {})}
          />
        ) : props.waitingOnId ? (
          <WaitingOnMarker personId={props.waitingOnId} />
        ) : (
          <AgeLabel type={type} lastActiveAt={props.lastActiveAt} />
        )}
      </span>
      <div className="absolute inset-y-0 right-1 z-10 flex items-center opacity-0 group-hover/home-thread:opacity-100 group-has-focus-visible/home-thread:opacity-100 group-has-data-popup-open/home-thread:opacity-100 pointer-coarse:static pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${isTask ? "Mark done" : "Archive"}: ${props.title}`}
                onClick={props.onArchive}
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2"
              />
            }
          >
            <ActionIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">{isTask ? "Done" : "Archive"}</TooltipPopup>
        </Tooltip>
        <RowMoreMenu movable={props.movable} currentKey={props.containerKey} />
      </div>
    </li>
  );
}
