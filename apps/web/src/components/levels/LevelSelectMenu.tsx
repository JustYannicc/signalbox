/**
 * A single-level picker for things that sit at exactly one Home level (a
 * device, an escalation rule). Things mapped into several levels use the
 * Plugins checkbox picker instead. Pass extra menu items (a reach toggle) as
 * children. Render inside a `LevelOptionsProvider`.
 */
import { FolderTreeIcon } from "lucide-react";
import type { ReactNode } from "react";

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
import { useLevelLabel, useLevelOptionsContext } from "./LevelOptionsProvider";
import type { LevelKey } from "./levels";

export function LevelSelectMenu(props: {
  /** Accessible name, e.g. "Level for Pixel 8 Pro". */
  label: string;
  value: LevelKey;
  onChange: (level: LevelKey) => void;
  children?: ReactNode;
}) {
  const levelLabel = useLevelLabel();
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" aria-label={props.label} />}>
        <FolderTreeIcon aria-hidden />
        {levelLabel(props.value)}
      </MenuTrigger>
      <MenuPopup align="end">
        <LevelRadioItems value={props.value} onChange={props.onChange} />
        {props.children}
      </MenuPopup>
    </Menu>
  );
}

// Its own component so the options are only read while the menu is open.
function LevelRadioItems(props: { value: LevelKey; onChange: (level: LevelKey) => void }) {
  const options = useLevelOptionsContext();
  return (
    <MenuGroup>
      <MenuGroupLabel>Sits at</MenuGroupLabel>
      <MenuRadioGroup
        value={props.value}
        onValueChange={(value) => {
          const option = options.find((candidate) => candidate.key === value);
          if (option) props.onChange(option.key);
        }}
      >
        {options.map((option) => (
          <MenuRadioItem key={option.key} value={option.key}>
            {option.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
}
