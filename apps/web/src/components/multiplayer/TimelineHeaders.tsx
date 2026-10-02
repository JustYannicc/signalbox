/**
 * Message headers every chat shares, solo or multiplayer: people on the right
 * with their avatar and name, harness turns on the left with the lab's avatar
 * and the model's name (never repeating the lab, never "for X").
 */
import { HarnessAvatar } from "../chat/HarnessAvatar";
import type { TeamPerson } from "./multiplayerModel";
import { PersonAvatar } from "./PersonAvatar";
import { PersonProfilePopover } from "./PersonProfile";
import { currentPerson } from "./teamThreads";

export function PersonMessageHeader(props: { person: TeamPerson }) {
  const { person } = props;
  return (
    <PersonProfilePopover
      person={person}
      trigger={
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded-full text-xs font-medium text-foreground outline-hidden ring-ring focus-visible:ring-2"
        >
          {person.id === currentPerson.id ? "You" : person.name}
          <PersonAvatar person={person} size="sm" />
        </button>
      }
    />
  );
}

export function HarnessMessageHeader(props: { provider: string; model: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1 text-xs">
      <HarnessAvatar provider={props.provider} size={20} />
      <span className="font-medium text-foreground">{props.model}</span>
    </div>
  );
}
