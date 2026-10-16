/**
 * The ⋯ menus of the folder tree: a folder's (make, rename, move, files,
 * pool, GitHub lend, instructions, secrets, delete) and an owner's top level.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  folderDeleteMessage,
  folderDestinations,
  folderSiblingMove,
  poolOfHome,
} from "@t3tools/client-runtime/state/signalboxFolders";
import { type EnvironmentId, ProjectId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { Folder, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderPlusIcon,
  HardDriveIcon,
  KeyRoundIcon,
  PencilIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";

import { usePoolViews } from "../../../state/accountPools";
import { PoolRadioSubmenu } from "../../accountPool/PoolRadioSubmenu";
import { environmentDrivesAtom } from "../../../state/signalboxDrives";
import { DriveProjectShareMenuItem } from "../../drives/DriveProjectShareMenuItem";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { openFolderDialog } from "./folderDialogStore";
import type { FolderOwner } from "./folderSidebarModel";
import type { FolderCommands } from "./useFolderCommands";

const NO_FILES = "none";

/** Says whose account a folder's CI steps run as once it's lent. */
const githubLendLabel = (folder: Folder) =>
  folder.githubLend ? `CI steps run as @${folder.githubLend.login}` : "Lend my GitHub to CI steps";

function MoreTrigger(props: { label: string }) {
  return (
    <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={props.label} />}>
      <EllipsisIcon />
    </MenuTrigger>
  );
}

interface FolderMenuProps {
  environmentId: EnvironmentId;
  snapshot: SignalboxFoldersSnapshot;
  owner: FolderOwner;
  folder: Folder;
  commands: FolderCommands;
}

export function FolderMenu(props: FolderMenuProps) {
  return (
    <Menu>
      <MoreTrigger label={`More for ${props.folder.name}`} />
      <MenuPopup align="end" side="right">
        <FolderMenuItems {...props} />
      </MenuPopup>
    </Menu>
  );
}

/** Mounts only while the menu is open, so closed rows hold no pool or drive subscriptions. */
function FolderMenuItems(props: FolderMenuProps) {
  const { environmentId, snapshot, owner, folder, commands } = props;
  const pools = usePoolViews(environmentId);
  const drives = (useAtomValue(environmentDrivesAtom).get(environmentId)?.drives ?? []).filter(
    (drive) =>
      drive.contextId === folder.ownerId && (drive.kind === "shared" || drive.kind === "folder"),
  );
  const destinations = folderDestinations(snapshot, folder.ownerId, folder.id).filter(
    (destination) => destination.folder.id !== folder.parentId,
  );
  // What this folder runs on when it picks nothing: whatever the level above it does.
  const inheritedPoolId = poolOfHome(snapshot, folder.parentId)?.poolId;
  const inheritedPoolName = pools.find((pool) => pool.id === inheritedPoolId)?.name;
  const moveUp = folderSiblingMove(snapshot, folder.id, "up");
  const moveDown = folderSiblingMove(snapshot, folder.id, "down");
  const files = folder.files?.projectId;
  // Its current files stay pickable while the drive list catches up.
  const filesUnlisted = files !== undefined && !drives.some((drive) => drive.projectId === files);

  return (
    <>
      <MenuItem
        onClick={() =>
          openFolderDialog({
            kind: "create",
            environmentId,
            ownerId: folder.ownerId,
            ownerName: owner.context.name,
            parent: folder,
          })
        }
      >
        <FolderPlusIcon />
        New folder inside
      </MenuItem>
      <MenuItem onClick={() => openFolderDialog({ kind: "rename", environmentId, folder })}>
        <PencilIcon />
        Rename
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger>
          <FolderInputIcon />
          Move to…
        </MenuSubTrigger>
        <MenuSubPopup>
          <MenuItem
            disabled={folder.parentId === null}
            onClick={() => void commands.move(environmentId, { id: folder.id, parentId: null })}
          >
            Top level
          </MenuItem>
          {destinations.map((destination) => (
            <MenuItem
              key={destination.folder.id}
              onClick={() =>
                void commands.move(environmentId, {
                  id: folder.id,
                  parentId: destination.folder.id,
                })
              }
            >
              {destination.label}
            </MenuItem>
          ))}
        </MenuSubPopup>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger>
          <HardDriveIcon />
          Files
        </MenuSubTrigger>
        <MenuSubPopup>
          <MenuRadioGroup
            value={folder.files?.projectId ?? NO_FILES}
            onValueChange={(value) =>
              void commands.setFiles(
                environmentId,
                folder.id,
                value === NO_FILES ? null : ProjectId.make(value),
              )
            }
          >
            <MenuRadioItem value={NO_FILES}>No files of its own</MenuRadioItem>
            {filesUnlisted ? <MenuRadioItem value={files}>{folder.name}</MenuRadioItem> : null}
            {drives.map((drive) => (
              <MenuRadioItem key={drive.id} value={drive.projectId}>
                {drive.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>
      {pools.length > 1 || folder.poolId !== undefined ? (
        <PoolRadioSubmenu
          pools={pools}
          value={folder.poolId}
          inheritedPoolName={inheritedPoolName}
          onChange={(poolId) => void commands.setPool(environmentId, folder.id, poolId)}
        />
      ) : null}
      {/* Shown while lent too, so a lend whose files went away can still be stopped. */}
      {folder.files || folder.githubLend ? (
        <MenuCheckboxItem
          variant="switch"
          checked={folder.githubLend !== undefined}
          onCheckedChange={(lent) => void commands.setGitHubLend(environmentId, folder.id, lent)}
        >
          {githubLendLabel(folder)}
        </MenuCheckboxItem>
      ) : null}
      <MenuItem
        onClick={() =>
          openFolderDialog({
            kind: "instructions",
            environmentId,
            level: { _tag: "folder", folderId: folder.id },
            name: folder.name,
            instructions: folder.instructions ?? "",
          })
        }
      >
        <FileTextIcon />
        Instructions…
      </MenuItem>
      <MenuItem
        onClick={() =>
          openFolderDialog({
            kind: "secrets",
            environmentId,
            level: { _tag: "folder", folderId: folder.id },
            name: folder.name,
          })
        }
      >
        <KeyRoundIcon />
        Secrets…
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        disabled={moveUp === null}
        onClick={() => moveUp && void commands.move(environmentId, moveUp)}
      >
        <ArrowUpIcon />
        Move up
      </MenuItem>
      <MenuItem
        disabled={moveDown === null}
        onClick={() => moveDown && void commands.move(environmentId, moveDown)}
      >
        <ArrowDownIcon />
        Move down
      </MenuItem>
      {folder.files ? (
        <DriveProjectShareMenuItem
          environmentId={environmentId}
          projectId={folder.files.projectId}
        />
      ) : null}
      <MenuSeparator />
      <MenuItem
        variant="destructive"
        onClick={() =>
          openFolderDialog({
            kind: "delete",
            environmentId,
            folder,
            message: folderDeleteMessage(snapshot, folder),
          })
        }
      >
        <Trash2Icon />
        Delete folder
      </MenuItem>
    </>
  );
}

/** An owner's top level: a new thread there, and (for Personal) the top level's instructions and secrets. */
export function OwnerMenu(props: {
  environmentId: EnvironmentId;
  snapshot: SignalboxFoldersSnapshot;
  owner: FolderOwner;
  canEdit: boolean;
  onNewThread: (() => void) | null;
}) {
  const { environmentId, snapshot, owner } = props;
  const editsTopLevel = props.canEdit && owner.context.id === PERSONAL_CONTEXT_ID;
  if (props.onNewThread === null && !editsTopLevel) return null;
  return (
    <Menu>
      <MoreTrigger label={`More for ${owner.context.name}`} />
      <MenuPopup align="end" side="right">
        {props.onNewThread ? (
          <MenuItem onClick={props.onNewThread}>
            <SquarePenIcon />
            New thread
          </MenuItem>
        ) : null}
        {editsTopLevel ? (
          <MenuItem
            onClick={() =>
              openFolderDialog({
                kind: "instructions",
                environmentId,
                level: { _tag: "top" },
                name: null,
                instructions: snapshot.top.instructions ?? "",
              })
            }
          >
            <FileTextIcon />
            Instructions…
          </MenuItem>
        ) : null}
        {editsTopLevel ? (
          <MenuItem
            onClick={() =>
              openFolderDialog({
                kind: "secrets",
                environmentId,
                level: { _tag: "top" },
                name: null,
              })
            }
          >
            <KeyRoundIcon />
            Secrets…
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
