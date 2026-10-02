/**
 * A person's profile card: who they are and the assistant that represents
 * them. "Ask Flynn's assistant" opens your latest open room with them, else a
 * new one in the container you're looking at (`ProfileContainerContext`) or
 * the top level. "Message Flynn" starts a new chat there, already shared with Flynn.
 */
import { useNavigate } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";
import { createContext, use, type ReactElement } from "react";

import { AssistantAvatar } from "../assistant/avatar";
import { ROOT_ROOM_CONTAINER_KEY, findRoom, roomIdForPerson } from "../rooms/rooms";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useItemGrantsStore } from "./itemAccess";
import { firstName, newDraftThreadId, type TeamPerson } from "./multiplayerModel";
import { useAssistantDirectory } from "./personAssistant";
import { PersonAvatar } from "./PersonAvatar";

/** Home container key (`section:…`, `team-project:…`) of the page showing profiles. */
export const ProfileContainerContext = createContext<string | null>(null);

export function PersonProfileCard(props: { person: TeamPerson; onNavigate?: () => void }) {
  const { person } = props;
  const navigate = useNavigate();
  const containerKey = use(ProfileContainerContext) ?? ROOT_ROOM_CONTAINER_KEY;
  const assistant = useAssistantDirectory()(person);
  const name = firstName(person.name);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <PersonAvatar person={person} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {person.name}
            {assistant.isYours ? " (you)" : ""}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {person.role} · {person.title}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2.5 rounded-lg bg-muted/50 p-2">
        <AssistantAvatar config={assistant.config} size={28} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{assistant.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {assistant.isYours ? "Your assistant" : `Represents ${name}`}
          </span>
        </div>
      </div>
      {assistant.isYours ? null : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              props.onNavigate?.();
              const threadId = newDraftThreadId();
              useItemGrantsStore.getState().grant(threadId, [person.id]);
              const project = containerKey.replace(/^(section|team-project):/, "");
              void navigate({
                to: "/shared/$threadId",
                params: { threadId },
                search: {
                  project: project === ROOT_ROOM_CONTAINER_KEY ? "home" : project,
                  kind: "chat",
                },
              });
            }}
          >
            <MessageCircleIcon />
            Message {name}
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              props.onNavigate?.();
              const roomId = roomIdForPerson(person.id);
              void navigate({
                to: "/rooms/$roomId",
                params: { roomId },
                search: findRoom(roomId) ? {} : { container: containerKey },
              });
            }}
          >
            <AssistantAvatar config={assistant.config} size={14} />
            Ask {name}'s assistant
          </Button>
        </div>
      )}
    </div>
  );
}

/** Wraps a trigger (avatar or name button) so clicking it shows the profile. */
export function PersonProfilePopover(props: {
  person: TeamPerson;
  trigger: ReactElement;
  onNavigate?: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger render={props.trigger} />
      <PopoverPopup side="bottom" align="start" width="sm" padding="compact">
        <PersonProfileCard
          person={props.person}
          {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}
        />
      </PopoverPopup>
    </Popover>
  );
}
