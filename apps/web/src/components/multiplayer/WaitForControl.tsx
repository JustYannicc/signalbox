/**
 * The composer's "Wait for…" control: pick who the agent should hear from
 * before it answers. While a wait is set it reads "Agent waits for Samir ×";
 * the × stops waiting.
 */
import { HourglassIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import type { TeamPerson } from "./multiplayerModel";
import { PersonAvatar } from "./PersonAvatar";
import { joinNames } from "./sharing";

export function WaitForControl(props: {
  /** People with access, other than you. */
  candidates: readonly TeamPerson[];
  waitingFor: readonly TeamPerson[];
  onChange: (ids: readonly string[]) => void;
}) {
  const waitingIds = new Set(props.waitingFor.map((person) => person.id));
  if (props.candidates.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center">
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              aria-label={
                waitingIds.size > 0
                  ? `Agent waits for ${joinNames(props.waitingFor, "")}`
                  : "Wait for someone before the agent replies"
              }
              onPointerDown={(event) => event.preventDefault()}
            />
          }
        >
          <HourglassIcon />
          {waitingIds.size > 0 ? `Agent waits for ${joinNames(props.waitingFor, "")}` : "Wait for…"}
        </MenuTrigger>
        <MenuPopup align="start" side="top">
          <MenuGroup>
            <MenuGroupLabel>Agent waits for</MenuGroupLabel>
            {props.candidates.map((person) => (
              <MenuCheckboxItem
                key={person.id}
                checked={waitingIds.has(person.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(waitingIds);
                  if (checked) next.add(person.id);
                  else next.delete(person.id);
                  props.onChange([...next]);
                }}
              >
                <PersonAvatar person={person} size="xs" />
                {person.name}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {waitingIds.size > 0 ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Stop waiting"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => props.onChange([])}
        >
          <XIcon />
        </Button>
      ) : null}
    </span>
  );
}
