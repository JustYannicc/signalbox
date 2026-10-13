/**
 * The "⋯" on a mapped strip row: where the thing lives and who else sees it.
 * Automations, accounts and places live in one folder and only move. Places
 * and accounts can also be referenced from other folders (that folder's agent
 * may use them) and be made available to every folder inside their home. A
 * reference row only offers "Remove reference". Skills keep Plugins' levels,
 * so they still sit in several folders at once. Every change toasts an undo.
 */
import {
  ChevronsDownIcon,
  EllipsisIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  FolderSymlinkIcon,
  UnlinkIcon,
} from "lucide-react";

import { useLevelPlacementStore } from "../../levels/leveledThings";
import type { Reach } from "../../levels/levels";
import { mappingHealth } from "../../spaces/spacesMappings";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import { useHomeDestinations } from "./homeMoves";
import { restoreMapped, snapshotMapped, useMappedStore, type MappedItem } from "./mappedItems";

/** Where a row's thing sits, read from the mapped index. */
export interface RowPlacement {
  /** Every folder it shows in (a skill's levels). */
  readonly shownIn: readonly string[];
  readonly home: string | null;
  readonly references: readonly string[];
  readonly reach: Reach;
}

function undoToast(id: string, message: string, undo: () => void) {
  toastManager.add({
    id: `mapped-${id}`,
    type: "success",
    title: message,
    timeout: 4000,
    actionProps: { children: "Undo", onClick: undo },
  });
}

/** Runs one placement change on a mapped id, with an undo back to the overrides before it. */
function changeMapped(id: string, message: string, change: () => void) {
  const before = snapshotMapped(id);
  change();
  undoToast(id, message, () => restoreMapped(id, before));
}

/** A skill's levels belong to Plugins' placement store, so both views stay one. */
function setSkillLevels(id: string, levels: readonly string[], message: string) {
  const placement = useLevelPlacementStore.getState();
  const previous = placement.levels[id];
  placement.setLevels(id, levels);
  undoToast(id, message, () => {
    const { [id]: _changed, ...rest } = useLevelPlacementStore.getState().levels;
    useLevelPlacementStore.setState({ levels: previous ? { ...rest, [id]: previous } : rest });
  });
}

function TriggerButton(props: { title: string }) {
  return (
    <MenuTrigger
      render={
        <button
          type="button"
          aria-label={`More for ${props.title}`}
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2"
        />
      }
    >
      <EllipsisIcon className="size-3.5" />
    </MenuTrigger>
  );
}

function DestinationSub(props: {
  icon: typeof FolderInputIcon;
  label: string;
  exclude: readonly string[];
  onPick: (key: string, label: string) => void;
}) {
  const destinations = useHomeDestinations().filter(
    (destination) => !props.exclude.includes(destination.key),
  );
  const Icon = props.icon;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <Icon />
        {props.label}
      </MenuSubTrigger>
      <MenuSubPopup>
        {destinations.map((destination) => (
          <MenuItem
            key={destination.key}
            onClick={() => props.onPick(destination.key, destination.label)}
          >
            {destination.label}
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

function SkillMenuItems(props: {
  id: string;
  title: string;
  containerKey: string;
  shownIn: readonly string[];
}) {
  const { id, title, shownIn } = props;
  const others = shownIn.filter((key) => key !== props.containerKey);
  return (
    <>
      <DestinationSub
        icon={FolderPlusIcon}
        label="Also show in…"
        exclude={shownIn}
        onPick={(key, label) =>
          setSkillLevels(id, [...shownIn, key], `${title} is also in ${label}`)
        }
      />
      <DestinationSub
        icon={FolderInputIcon}
        label="Move to…"
        exclude={shownIn}
        onPick={(key, label) => setSkillLevels(id, [...others, key], `Moved ${title} to ${label}`)}
      />
      {others.length > 0 ? (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => setSkillLevels(id, others, `Removed ${title} from here`)}>
            <FolderMinusIcon />
            Remove from here
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

function HomeMenuItems(props: {
  item: Exclude<MappedItem, { kind: "skill" }>;
  title: string;
  placement: RowPlacement;
}) {
  const { item, title } = props;
  const { home, references, reach } = props.placement;
  const store = useMappedStore.getState;
  const referable = item.kind !== "automation";
  return (
    <>
      <DestinationSub
        icon={FolderInputIcon}
        label="Move to…"
        exclude={home === null ? [] : [home]}
        onPick={(key, label) =>
          changeMapped(item.id, `Moved ${title} to ${label}`, () => {
            store().setHome(item.id, key);
            // Moving into a folder that referenced it makes the reference moot.
            if (references.includes(key)) {
              store().setReferences(
                item.id,
                references.filter((reference) => reference !== key),
              );
            }
          })
        }
      />
      {referable ? (
        <>
          <DestinationSub
            icon={FolderSymlinkIcon}
            label="Reference in…"
            exclude={home === null ? references : [home, ...references]}
            onPick={(key, label) =>
              changeMapped(item.id, `${title} is referenced in ${label}`, () =>
                store().setReferences(item.id, [...references, key]),
              )
            }
          />
          <MenuSeparator />
          <MenuCheckboxItem
            variant="switch"
            checked={reach === "below"}
            onCheckedChange={(checked) => store().setReach(item.id, checked ? "below" : "here")}
          >
            <span className="flex items-center gap-2">
              <ChevronsDownIcon />
              Available to folders inside
            </span>
          </MenuCheckboxItem>
        </>
      ) : null}
      {item.kind === "place" ? (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={() =>
              changeMapped(
                item.id,
                `${title} is unmapped; its items are back in ${mappingHealth(item.mapping).accountName}`,
                () => {
                  store().setHome(item.id, null);
                  store().setReferences(item.id, []);
                },
              )
            }
          >
            <FolderMinusIcon />
            Unmap
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

export function MappedRowMenu(props: {
  item: MappedItem;
  title: string;
  containerKey: string;
  placement: RowPlacement;
  /** The row shows a reference, not the thing's home. */
  reference: boolean;
}) {
  const { item, title, containerKey, placement } = props;
  return (
    <Menu>
      <TriggerButton title={title} />
      <MenuPopup align="start" side="right">
        {item.kind === "skill" ? (
          <SkillMenuItems
            id={item.id}
            title={title}
            containerKey={containerKey}
            shownIn={placement.shownIn}
          />
        ) : props.reference ? (
          <MenuItem
            onClick={() =>
              changeMapped(item.id, `Removed the reference to ${title} from here`, () =>
                useMappedStore.getState().setReferences(
                  item.id,
                  placement.references.filter((key) => key !== containerKey),
                ),
              )
            }
          >
            <UnlinkIcon />
            Remove reference
          </MenuItem>
        ) : (
          <HomeMenuItems item={item} title={title} placement={placement} />
        )}
      </MenuPopup>
    </Menu>
  );
}
