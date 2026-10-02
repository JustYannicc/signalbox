/**
 * The editable parts of the Share dialog for a chat, task or room: add people
 * from the team, and switch general access between "only people added" and
 * the team. Changes route through `useAccessControls`, which confirms.
 */
import { ChevronDownIcon, LockIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { TEAM_PEOPLE } from "./multiplayerFixtures";
import { PersonAvatar } from "./PersonAvatar";

const MAX_MATCHES = 4;

export function AddPeopleField(props: {
  /** People who already have access; they aren't suggested. */
  excludedIds: ReadonlySet<string>;
  onAdd: (personIds: readonly string[]) => void;
  /** Someone not on the team; confirmed like any share. */
  onInvite: (email: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? TEAM_PEOPLE.filter(
        (person) =>
          !props.excludedIds.has(person.id) &&
          (person.name.toLowerCase().includes(needle) ||
            person.email.toLowerCase().includes(needle)),
      ).slice(0, MAX_MATCHES)
    : [];

  const add = (personId: string) => {
    setQuery("");
    props.onAdd([personId]);
  };

  return (
    <div className="flex flex-col gap-1">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const first = matches[0];
          if (first) {
            add(first.id);
          } else if (needle) {
            props.onInvite(query.trim());
            setQuery("");
          }
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Add people by name or email"
          aria-label="Add people"
        />
        <Button type="submit" variant="outline" disabled={!needle}>
          Add
        </Button>
      </form>
      {matches.length > 0 ? (
        <ul aria-label="Matching people" className="flex flex-col">
          {matches.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                onClick={() => add(person.id)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-hidden hover:bg-accent focus-visible:bg-accent"
              >
                <PersonAvatar person={person} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {person.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">{person.email}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function GeneralAccessControl(props: {
  scope: "team" | "restricted";
  teamName: string;
  onChange: (scope: "team" | "restricted") => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
        {props.scope === "team" ? `Anyone in ${props.teamName}` : "Only people added"}
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={props.scope}
          onValueChange={(value) => {
            if ((value === "team" || value === "restricted") && value !== props.scope) {
              props.onChange(value);
            }
          }}
        >
          <MenuRadioItem value="restricted">
            <LockIcon />
            Only people added
          </MenuRadioItem>
          <MenuRadioItem value="team">
            <UsersIcon />
            Anyone in {props.teamName}
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
