/**
 * Level badges, the "managed by admins" note, and the level picker shared by
 * every section that shows where a thing sits in the Home hierarchy. The
 * picker also holds the thing's reach ("Available to folders inside"); a
 * small arrow on the badge marks things that reach below.
 */
import { CornerDownRightIcon, FolderTreeIcon, ShieldIcon } from "lucide-react";

import { setThingReach, toggleThingLevel, useThingReach } from "../levels/leveledThings";
import { useLevelLabel, useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { TOP_LEVEL, type LevelKey, type Reach } from "../levels/levels";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { LEVEL_POLICIES } from "./levelPolicyFixtures";
import {
  isRestricted,
  managedLine,
  policyFor,
  type LevelPolicy,
  type PermissionArea,
} from "./levelPolicyModel";
import type { AddedBy } from "./pluginsModel";

/** The levels a thing sits at, by folder path: "Work › Northwind team + Personal". */
export function LevelBadges(props: { levels: readonly LevelKey[]; reach?: Reach | undefined }) {
  const label = useLevelLabel();
  const placed = props.levels.length > 0;
  const below = placed && props.reach === "below";
  return (
    <Badge
      variant={placed ? "secondary" : "outline"}
      size="sm"
      title={below ? "Also available to folders inside" : undefined}
    >
      {placed ? props.levels.map(label).join(" + ") : "Not placed"}
      {below ? (
        <>
          <CornerDownRightIcon aria-hidden />
          <span className="sr-only">and folders inside</span>
        </>
      ) : null}
    </Badge>
  );
}

/** Shown once per restricted area instead of a lock on every row. */
export function ManagedNote(props: { policy: LevelPolicy }) {
  return (
    <Badge variant="outline" size="sm">
      <ShieldIcon aria-hidden />
      {managedLine(props.policy)}
    </Badge>
  );
}

/** Checkbox menu for which Home levels a thing sits at, plus its reach when `onReachChange` is set. */
export function LevelPicker(props: {
  itemName: string;
  levels: readonly LevelKey[];
  onToggle: (level: LevelKey, checked: boolean) => void;
  reach?: Reach | undefined;
  onReachChange?: ((reach: Reach) => void) | undefined;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost" aria-label={`Levels for ${props.itemName}`} />}
      >
        <FolderTreeIcon aria-hidden />
        <LevelBadges levels={props.levels} reach={props.reach} />
      </MenuTrigger>
      <MenuPopup align="end">
        <LevelPickerItems levels={props.levels} onToggle={props.onToggle} />
        {props.onReachChange ? (
          <>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={props.reach === "below"}
              onCheckedChange={(checked) => props.onReachChange?.(checked ? "below" : "here")}
            >
              Available to folders inside
            </MenuCheckboxItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

// Its own component so the options are only read while the menu is open.
function LevelPickerItems(props: {
  levels: readonly LevelKey[];
  onToggle: (level: LevelKey, checked: boolean) => void;
}) {
  const options = useLevelOptionsContext();
  return (
    <MenuGroup>
      <MenuGroupLabel>Sits at</MenuGroupLabel>
      {options.map((option) => (
        <MenuCheckboxItem
          key={option.key}
          checked={props.levels.includes(option.key)}
          onCheckedChange={(checked) => props.onToggle(option.key, checked)}
        >
          {option.label}
        </MenuCheckboxItem>
      ))}
    </MenuGroup>
  );
}

/**
 * A thing's levels: a picker when you may move it (yours, or the area is open
 * to members), otherwise just the badges. Changes go to the shared placement store.
 */
export function ThingLevels(props: {
  /** `account:<id>`, `integration:<id>`, `skill:<id>`, `plugin:<id>`. */
  thingKey: string;
  itemName: string;
  levels: readonly LevelKey[];
  area: PermissionArea;
  addedBy: AddedBy;
  /** The fixture's reach, until you change it. */
  reach?: Reach | undefined;
}) {
  const policy = policyFor(props.levels[0] ?? TOP_LEVEL, LEVEL_POLICIES);
  const reach = useThingReach(props.thingKey, props.reach);
  if (props.addedBy === "admins" && isRestricted(policy, props.area)) {
    return <LevelBadges levels={props.levels} reach={reach} />;
  }
  return (
    <LevelPicker
      itemName={props.itemName}
      levels={props.levels}
      onToggle={(level, checked) => toggleThingLevel(props.thingKey, props.levels, level, checked)}
      reach={reach}
      onReachChange={(next) => setThingReach(props.thingKey, next)}
    />
  );
}
