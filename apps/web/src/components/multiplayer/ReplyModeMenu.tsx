/**
 * The shared chat's ⋯ menu: when the agent replies (each message, or once
 * everyone has replied). Changes are logged in the timeline.
 */
import { EllipsisIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { logTeamEvent } from "./localMessages";
import { firstName, type ReplyMode } from "./multiplayerModel";
import { REPLY_MODE_LABEL, useReplyModeStore } from "./replyMode";
import { currentPerson } from "./teamThreads";

export function ReplyModeMenu(props: { threadId: string; mode: ReplyMode }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Chat options" />}>
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Agent replies</MenuGroupLabel>
          <MenuRadioGroup
            value={props.mode}
            onValueChange={(value) => {
              if ((value !== "each" && value !== "everyone") || value === props.mode) return;
              useReplyModeStore.getState().setMode(props.threadId, value);
              logTeamEvent(
                props.threadId,
                "mode",
                value === "each"
                  ? `${firstName(currentPerson.name)} set the agent to reply to each message`
                  : `${firstName(currentPerson.name)} set the agent to reply once everyone has replied`,
              );
            }}
          >
            <MenuRadioItem value="each">{REPLY_MODE_LABEL.each}</MenuRadioItem>
            <MenuRadioItem value="everyone">{REPLY_MODE_LABEL.everyone}</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
