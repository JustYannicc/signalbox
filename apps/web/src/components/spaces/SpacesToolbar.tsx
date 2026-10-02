/**
 * Page-level controls for Spaces: the Library / Just Files lens and the layout
 * overflow menu.
 */
import { EllipsisIcon, FolderTreeIcon, LibraryIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { SpacesLayout } from "./SpacesHumanBody";

export const comingSoon = () => toastManager.add({ type: "info", title: "Coming soon" });

export function SpacesLensToggle(props: {
  lens: "library" | "files";
  onChange: (lens: "library" | "files") => void;
}) {
  return (
    <ToggleGroup
      aria-label="View"
      value={[props.lens]}
      onValueChange={(next) => {
        if (next[0] === "library" || next[0] === "files") props.onChange(next[0]);
      }}
    >
      <Toggle value="library">
        <LibraryIcon />
        Library
      </Toggle>
      <Toggle value="files">
        <FolderTreeIcon />
        Just Files
      </Toggle>
    </ToggleGroup>
  );
}

export function SpacesOverflowMenu(props: {
  layout: SpacesLayout;
  onLayoutChange: (layout: SpacesLayout) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon" variant="ghost" aria-label="More options" />}>
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={props.layout}
          onValueChange={(value) => {
            if (value === "list" || value === "grid") props.onLayoutChange(value);
          }}
        >
          <MenuRadioItem value="list">List</MenuRadioItem>
          <MenuRadioItem value="grid">Grid</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
