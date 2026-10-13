/**
 * Header chip on agent pages: "Only you" for agents of personal levels,
 * "Shared" with the team's faces for agents of team levels (`levelSharing`).
 */
import { UsersIcon } from "lucide-react";

import { OnlyYouChip } from "../assistant/ChatHeaderControls";
import { AvatarStack } from "../multiplayer/PersonAvatar";
import { joinNames } from "../multiplayer/sharing";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { LevelKey } from "./levels";
import { levelAgentPeople, levelTeam } from "./levelSharing";

export function AgentSharingChip(props: { level: LevelKey | null; agentName: string }) {
  const team = props.level ? levelTeam(props.level) : null;
  if (!props.level || !team) return <OnlyYouChip agentName={props.agentName} />;
  const people = levelAgentPeople(props.level);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground" />
        }
      >
        <UsersIcon aria-hidden className="size-3" />
        Shared
        <AvatarStack people={people} size="2xs" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.agentName} is shared with {team.name}: {joinNames(people, team.name)}. It coordinates
        the shared work here. Private chats and tasks stay with whoever owns them.
      </TooltipPopup>
    </Tooltip>
  );
}
