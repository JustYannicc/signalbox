/** Header controls shared by the assistant and agent pages: privacy and history. */
import { HistoryIcon, LockIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ChatHistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}

/** Dropdown of earlier chats. `viewingId` is null while the current chat is on screen. */
export function ChatHistoryMenu(props: {
  groupLabel: string;
  entries: readonly ChatHistoryEntry[];
  viewingId: string | null;
  backLabel: string;
  onSelect: (id: string | null) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="History" />} />
          }
        >
          <HistoryIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">History</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>{props.groupLabel}</MenuGroupLabel>
          {props.entries.length === 0 ? (
            <MenuItem disabled>No earlier chats</MenuItem>
          ) : (
            <MenuRadioGroup
              value={props.viewingId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string" && value) props.onSelect(value);
              }}
            >
              {props.entries.map((entry) => (
                <MenuRadioItem key={entry.id} value={entry.id}>
                  <span className="flex min-w-48 items-center justify-between gap-6">
                    {entry.title}
                    <span className="text-xs text-muted-foreground tabular-nums">{entry.meta}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </MenuGroup>
        {props.viewingId ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onSelect(null)}>{props.backLabel}</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Supervisors are personal: only their owner sees them, and they see what the owner sees. */
export function OnlyYouChip(props: { agentName: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground" />
        }
      >
        <LockIcon aria-hidden className="size-3" />
        Only you
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.agentName} is yours alone. It sees your private chats and whatever is shared with
        you.
      </TooltipPopup>
    </Tooltip>
  );
}
