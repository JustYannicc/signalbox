/**
 * The room composer. By default you tell your own assistant what to ask or
 * answer; "Step in as Yannic" writes to the room yourself. No model picker
 * (people and assistants talk here, no agent run starts). @ reaches only the
 * other owner. While the room waits on you, quick replies answer in one tap.
 * Sends append to the room locally.
 */
import { UserRoundIcon } from "lucide-react";
import { useState } from "react";

import { MockBoundComposer } from "../chat/MockBoundComposer";
import { localMessageId, nowLabel, useLocalMessagesStore } from "../multiplayer/localMessages";
import { useMentionDirectory } from "../multiplayer/mentionDirectory";
import { firstName, type TeamPerson } from "../multiplayer/multiplayerModel";
import { useAssistantDirectory } from "../multiplayer/personAssistant";
import { currentPerson } from "../multiplayer/teamThreads";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import type { Room } from "./roomModel";

export function RoomComposer(props: { room: Room; other: TeamPerson | undefined }) {
  const { room, other } = props;
  const [steppingIn, setSteppingIn] = useState(false);
  const own = useAssistantDirectory()(currentPerson);
  const { source } = useMentionDirectory({
    containerId: null,
    peopleIds: other ? [other.id] : [],
    includeAgents: false,
  });
  const me = firstName(currentPerson.name);
  const otherName = other ? firstName(other.name) : "them";
  const waitingOnYou = room.status === "open" && room.waitingOnId === currentPerson.id;
  /** You step in as yourself, or your assistant says it for you. */
  const deliver = (text: string, files: readonly File[] = []) =>
    useLocalMessagesStore.getState().addRoom(room.id, [
      {
        id: localMessageId(),
        speaker: steppingIn ? "person" : "assistant",
        personId: currentPerson.id,
        body: { kind: "text", text },
        at: nowLabel(),
        ...(files.length > 0 ? { files: files.map((file) => file.name) } : {}),
      },
    ]);

  return (
    <div className="flex flex-col gap-2">
      {waitingOnYou && room.quickReplies && room.quickReplies.length > 0 ? (
        <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-wrap gap-2">
          {room.quickReplies.map((reply) => (
            <Button key={reply} size="xs" variant="outline" onClick={() => deliver(reply)}>
              {reply}
            </Button>
          ))}
        </div>
      ) : null}
      <MockBoundComposer
        targetKey={`room:${room.id}`}
        placeholder={
          steppingIn ? `Write to ${otherName} as ${me}` : `Tell ${own.name} what to ask or answer`
        }
        mentions={source}
        attachments
        controls={
          <Toggle
            variant="ghost"
            size="sm"
            pressed={steppingIn}
            onPressedChange={setSteppingIn}
            onPointerDown={(event) => event.preventDefault()}
          >
            <UserRoundIcon />
            Step in as {me}
          </Toggle>
        }
        onSend={deliver}
      />
    </div>
  );
}
