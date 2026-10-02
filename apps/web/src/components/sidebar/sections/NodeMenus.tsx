/**
 * Hover actions for the tree: one "+" (opens quick capture tagged with the
 * container) and one "⋯" (new subsection, rename, move, share, archive); rows
 * get a "⋯" with Move to…. Plus the team row's people cluster, which opens the
 * Share dialog.
 */
import {
  ArchiveIcon,
  EllipsisIcon,
  FolderInputIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  Share2Icon,
} from "lucide-react";
import { useState } from "react";

import { openQuickCapture } from "../../capture/captureModel";
import type { CaptureToken } from "../../capture/captureTokens";
import { useAccessItem } from "../../multiplayer/itemAccess";
import type { Team } from "../../multiplayer/multiplayerModel";
import { AvatarStack } from "../../multiplayer/PersonAvatar";
import { ShareDialog } from "../../multiplayer/ShareDialog";
import { defaultScopeFor, type ShareTarget } from "../../multiplayer/sharing";
import { currentPerson, peopleByIds } from "../../multiplayer/teamThreads";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SidebarHeaderIconButton } from "../SidebarThreadHeader";
import { destinationsFor, moveTo, useHomeDestinations, type HomeMovable } from "./homeMoves";
import { useHomeSectionStore } from "./sectionStore";

/** "+": quick capture, pre-tagged with the container (`#merchant-portal`). */
export function NodeAddButton(props: { token: CaptureToken }) {
  return (
    <SidebarHeaderIconButton
      label={`New in ${props.token.label}`}
      onClick={() => openQuickCapture({ tokens: [props.token] })}
    >
      <PlusIcon />
    </SidebarHeaderIconButton>
  );
}

function MoveToSub(props: { movable: HomeMovable; currentKey: string }) {
  const destinations = destinationsFor(props.movable, useHomeDestinations()).filter(
    (destination) => destination.key !== props.currentKey,
  );
  return (
    <MenuSub>
      <MenuSubTrigger>
        <FolderInputIcon />
        Move to…
      </MenuSubTrigger>
      <MenuSubPopup>
        {destinations.map((destination) => (
          <MenuItem key={destination.key} onClick={() => moveTo(props.movable, destination)}>
            {destination.label}
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/**
 * Share for a container with no team: "shared" there means only the people
 * added directly, so it is edited like any single item.
 */
function PersonalShareDialog(props: {
  containerKey: string;
  containerId: string;
  name: string;
  onOpenChange: (open: boolean) => void;
}) {
  const item = useAccessItem({
    id: `container:${props.containerKey}`,
    title: props.name,
    kind: "chat",
    containerId: props.containerId,
    ownerIds: [currentPerson.id],
    repliedIds: [],
    initialVisibility: defaultScopeFor(props.containerId),
  });
  return <ShareDialog target={{ kind: "item", item }} open onOpenChange={props.onOpenChange} />;
}

export function NodeMoreMenu(props: {
  nodeKey: string;
  name: string;
  movable: HomeMovable;
  /** Where the node sits now, left out of Move to…. */
  currentKey: string;
  /** Team-backed share target; personal containers share by direct grants. */
  share: ShareTarget | null;
  /** The multiplayer container id personal sharing is measured against. */
  containerId: string;
  onArchive: () => void;
  /** Sections can hold subsections. */
  sectionId?: string;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const store = useHomeSectionStore.getState;
  return (
    <>
      <Menu>
        <MenuTrigger render={<SidebarHeaderIconButton label={`More for ${props.name}`} />}>
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="start" side="right">
          {props.sectionId ? (
            <MenuItem onClick={() => store().createSection(props.sectionId ?? null)}>
              <FolderPlusIcon />
              New subsection
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => store().setRenaming(props.nodeKey)}>
            <PencilIcon />
            Rename
          </MenuItem>
          <MoveToSub movable={props.movable} currentKey={props.currentKey} />
          <MenuItem onClick={() => setShareOpen(true)}>
            <Share2Icon />
            Share…
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={props.onArchive}>
            <ArchiveIcon />
            Archive
          </MenuItem>
        </MenuPopup>
      </Menu>
      {shareOpen && props.share ? (
        <ShareDialog target={props.share} open onOpenChange={setShareOpen} />
      ) : null}
      {shareOpen && !props.share ? (
        <PersonalShareDialog
          containerKey={props.nodeKey}
          containerId={props.containerId}
          name={props.name}
          onOpenChange={setShareOpen}
        />
      ) : null}
    </>
  );
}

/** A row's "⋯": where else it could live. */
export function RowMoreMenu(props: { movable: HomeMovable; currentKey: string }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`More for ${props.movable.label}`}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2"
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start" side="right">
        <MoveToSub movable={props.movable} currentKey={props.currentKey} />
      </MenuPopup>
    </Menu>
  );
}

/** A team's people, at most three overlapped avatars; opens who-has-access. */
export function TeamCluster(props: { team: Team }) {
  const [open, setOpen] = useState(false);
  const members = peopleByIds(props.team.memberIds);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`${props.team.name}: ${members.length} people. Manage access`}
              onClick={() => setOpen(true)}
              className="mr-1 flex shrink-0 cursor-pointer items-center rounded-full outline-hidden ring-ring focus-visible:ring-2"
            />
          }
        >
          <AvatarStack
            people={members.slice(0, 3)}
            max={3}
            size="xs"
            ringClassName="ring-1 ring-sidebar"
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{members.length} people · manage access</TooltipPopup>
      </Tooltip>
      {open ? (
        <ShareDialog target={{ kind: "team", teamId: props.team.id }} open onOpenChange={setOpen} />
      ) : null}
    </>
  );
}
