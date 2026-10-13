/**
 * The shared chat's "Agent replies" setting in Thread details: when the agent
 * replies (each message, or once everyone has replied). Changes are logged in
 * the timeline.
 */
import { MessagesSquareIcon } from "lucide-react";

import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { cn } from "../../lib/utils";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { logTeamEvent } from "./localMessages";
import { firstName, type ReplyMode } from "./multiplayerModel";
import { REPLY_MODE_LABEL, useReplyModeStore } from "./replyMode";
import { currentPerson } from "./teamThreads";

export function ReplyModeSection(props: { threadId: string; mode: ReplyMode }) {
  return (
    <ThreadDetailsSection headingId="surface-details-replies-heading" title="Agent replies">
      <Menu>
        <MenuTrigger
          render={<ThreadDetailsControl part="select" aria-label="When the agent replies" />}
        >
          <MessagesSquareIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {REPLY_MODE_LABEL[props.mode]}
          </span>
        </MenuTrigger>
        <MenuPopup align="end">
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
        </MenuPopup>
      </Menu>
    </ThreadDetailsSection>
  );
}
