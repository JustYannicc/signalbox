/**
 * The row every level of the Home tree shares, folders and member levels
 * alike, and the small pieces that sit on it. Per-folder elements plug into
 * its slots: `name` takes a node (e.g. the name wrapped in a status tooltip),
 * `afterName` sits right after it (a phase), `trailing` at the end while at
 * rest (a thread count or status rollup), and `actions` replace `trailing` on
 * hover or focus.
 */
import { ChevronRightIcon, SquarePenIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { SidebarMenuItem } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

/**
 * One foldable level row: a folder or a member level. The name folds it (so
 * do ←/→). `trailing` holds the row's small at-rest markers, such as its
 * thread count; they hide while `actions` show on hover or focus.
 */
export function LevelRow(props: {
  expanded: boolean;
  onToggle: () => void;
  icon: ReactNode;
  name: ReactNode;
  afterName?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  /** Drops the indent past a depth, so deep trees keep their names readable. */
  indentChildren: boolean;
  children: ReactNode;
}) {
  const { expanded, onToggle } = props;
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded)) {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <SidebarMenuItem>
      <div className="group/folder-row flex h-8 items-center gap-0.5 rounded-md pe-1 hover:bg-sidebar-row-hover has-data-popup-open:bg-sidebar-row-hover">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          onKeyDown={handleKeyDown}
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md ps-1 text-left outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground/60 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          {props.icon}
          <span className="min-w-0 truncate text-sm font-medium text-sidebar-muted-foreground/85">
            {props.name}
          </span>
          {props.afterName}
          {props.trailing ? (
            <span className="ms-auto flex shrink-0 items-center gap-1 pe-1 group-hover/folder-row:hidden group-focus-within/folder-row:hidden group-has-data-popup-open/folder-row:hidden pointer-coarse:hidden">
              {props.trailing}
            </span>
          ) : null}
        </button>
        {props.actions ? (
          <span className="hidden shrink-0 items-center group-hover/folder-row:flex group-focus-within/folder-row:flex group-has-data-popup-open/folder-row:flex pointer-coarse:flex">
            {props.actions}
          </span>
        ) : null}
      </div>
      {expanded ? (
        <ul className={cn("flex flex-col gap-1", props.indentChildren && "ps-3")}>
          {props.children}
        </ul>
      ) : null}
    </SidebarMenuItem>
  );
}

/** A small row inside a level, under its name: its files, its automations. */
export const LEVEL_ITEM_ROW_CLASS =
  "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md ps-5.5 pe-2 text-left text-xs outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset";

export function ThreadCount(props: { count: number }) {
  if (props.count === 0) return null;
  return (
    <span className="text-3xs tabular-nums text-sidebar-muted-foreground/50">
      {props.count}
      <span className="sr-only"> {props.count === 1 ? "thread" : "threads"}</span>
    </span>
  );
}

export function NewThreadButton(props: { name: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`New thread in ${props.name}`}
            onClick={props.onClick}
          />
        }
      >
        <SquarePenIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">New thread</TooltipPopup>
    </Tooltip>
  );
}
