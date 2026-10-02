/**
 * Group badges, the "managed by admins" note, and the group picker shared by
 * every section that shows what an item belongs to.
 */
import { ShieldIcon, UsersIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { managedLine, type AccessGroup } from "./groupsModel";
import { GROUPS } from "./groupsFixtures";
import type { GroupId } from "./pluginsModel";

export function groupById(id: GroupId) {
  return GROUPS.find((group) => group.id === id);
}

/** The organization-wide group; publishing a skill shares it with everyone in it. */
export function orgGroup() {
  return GROUPS.find((group) => group.org !== undefined);
}

export function groupNames(ids: readonly GroupId[]) {
  return ids.map((id) => groupById(id)?.name ?? id).join(" + ");
}

/** The groups an item reaches, by name: "Northwind", or "Northwind + Personal". */
export function GroupBadges(props: { groups: readonly GroupId[] }) {
  return (
    <Badge variant={props.groups.length === 0 ? "outline" : "secondary"} size="sm">
      {props.groups.length === 0 ? "No group" : groupNames(props.groups)}
    </Badge>
  );
}

/** Shown once per restricted area instead of a lock on every row. */
export function ManagedNote(props: { group: AccessGroup }) {
  return (
    <Badge variant="outline" size="sm">
      <ShieldIcon aria-hidden />
      {managedLine(props.group)}
    </Badge>
  );
}

/** Checkbox menu for which groups an item belongs to. */
export function GroupPicker(props: {
  itemName: string;
  groups: readonly GroupId[];
  onToggle: (groupId: GroupId, checked: boolean) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost" aria-label={`Groups for ${props.itemName}`} />}
      >
        <UsersIcon aria-hidden />
        <GroupBadges groups={props.groups} />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Available in</MenuGroupLabel>
          {GROUPS.map((group) => (
            <MenuCheckboxItem
              key={group.id}
              checked={props.groups.includes(group.id)}
              onCheckedChange={(checked) => props.onToggle(group.id, checked)}
            >
              {group.name}
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
