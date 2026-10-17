// signalbox: one row per level of the tree: your top level, its folders, and member levels, nested.
import { ownerLevelName, type FolderNode } from "@t3tools/client-runtime/state/signalboxFolders";
import type { MenuAction } from "@react-native-menu/menu";
import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import type { Folder, FolderId } from "@t3tools/contracts/signalboxFolders";
import { memo, useCallback, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";

const MAX_VISUAL_DEPTH = 5;
const NO_ACTIONS: MenuAction[] = [];

type MenuEvent = { readonly nativeEvent: { readonly event: string } };

/** A row's ⋯ button and its native menu. */
function RowMenu(props: {
  readonly label: string;
  readonly actions: MenuAction[];
  readonly onPressAction: (event: MenuEvent) => void;
}) {
  if (props.actions.length === 0) return null;
  return (
    <Menu actions={props.actions} onPressAction={props.onPressAction} title={props.label}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${props.label}`}
        className="size-10 items-center justify-center rounded-full active:bg-subtle-strong"
      >
        <SymbolView name="ellipsis" size={16} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </Menu>
  );
}

/**
 * A selectable level: its name, how many threads are in it or below, and a
 * menu. A folder where something moves says so quietly under its name.
 */
function LevelRow(props: {
  readonly depth: number;
  readonly icon: "folder" | "folder.fill" | "building.2";
  readonly name: string;
  readonly accessibilityLabel: string;
  readonly count: number;
  /** signalbox: status roll-up (#670), "2 working · 1 waiting"; null when nothing moves. */
  readonly summary?: string | null;
  /** The source folder, captured when this folder started. */
  readonly origin?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly leading?: ReactNode;
  readonly menu: ReactNode;
}) {
  return (
    <View
      className={props.selected ? "flex-row items-center bg-subtle" : "flex-row items-center"}
      style={{ paddingLeft: 4 + Math.min(props.depth, MAX_VISUAL_DEPTH) * 18, paddingRight: 8 }}
    >
      <View className="size-10 items-center justify-center">{props.leading}</View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          props.summary
            ? `${props.accessibilityLabel}, ${props.summary.replaceAll(" · ", ", ")}`
            : props.accessibilityLabel
        }
        accessibilityState={{ selected: props.selected }}
        accessibilityHint={props.origin ? `Based on ${props.origin}` : undefined}
        className={
          props.origin || props.summary
            ? "min-h-13 min-w-0 flex-1 flex-row items-center gap-2 py-1 active:opacity-75"
            : "min-h-11 min-w-0 flex-1 flex-row items-center gap-2 py-1 active:opacity-75"
        }
        onPress={props.onSelect}
      >
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName={props.selected ? "accent-primary" : "accent-icon-muted"}
        />
        <View className="min-w-0 flex-1">
          <AppText
            className={
              props.depth === 0
                ? "min-w-0 font-t3-medium text-foreground"
                : "min-w-0 text-sm text-foreground"
            }
            numberOfLines={1}
          >
            {props.name}
          </AppText>
          {props.summary || props.origin ? (
            <AppText className="text-xs text-foreground-muted" numberOfLines={2}>
              {[props.summary, props.origin ? `Based on ${props.origin}` : null]
                .filter(Boolean)
                .join(" · ")}
            </AppText>
          ) : null}
        </View>
        {props.count > 0 ? (
          <AppText className="text-xs tabular-nums text-foreground-muted">{props.count}</AppText>
        ) : null}
      </Pressable>
      {props.menu}
    </View>
  );
}

/**
 * A level's own row: your top level (depth 0), or an organization you're a
 * member of inside it. Selecting it shows the threads in none of its folders.
 */
export const OwnerTopLevelRow = memo(function OwnerTopLevelRow(props: {
  readonly owner: SignalboxContext;
  readonly depth: number;
  readonly selected: boolean;
  readonly actions: MenuAction[];
  readonly onSelect: (owner: SignalboxContext) => void;
  readonly onAction: (owner: SignalboxContext, event: string) => void;
}) {
  const { owner, onAction, onSelect } = props;
  const handleMenu = useCallback(
    (event: MenuEvent) => onAction(owner, event.nativeEvent.event),
    [onAction, owner],
  );
  const handleSelect = useCallback(() => onSelect(owner), [onSelect, owner]);
  const name = ownerLevelName(owner);
  const personal = owner.kind === "personal";
  return (
    <LevelRow
      depth={props.depth}
      icon={personal ? "folder.fill" : "building.2"}
      name={name}
      accessibilityLabel={
        personal ? "Threads at the top level" : `Threads at the top of ${owner.name}`
      }
      count={0}
      selected={props.selected}
      onSelect={handleSelect}
      menu={<RowMenu label={name} actions={props.actions} onPressAction={handleMenu} />}
    />
  );
});

export interface FolderRowContext {
  readonly counts: ReadonlyMap<FolderId, number>;
  /** Each folder's status roll-up line, where something moves. */
  readonly summaries: ReadonlyMap<FolderId, string>;
  readonly selectedFolderId: FolderId | null;
  readonly collapsed: ReadonlySet<FolderId>;
  /** Each folder's menu, built once per snapshot. */
  readonly menus: ReadonlyMap<FolderId, MenuAction[]>;
  readonly onSelect: (folder: Folder) => void;
  readonly onToggle: (folder: Folder) => void;
  readonly onAction: (folder: Folder, event: string) => void;
}

/** A folder and, unless collapsed, the folders inside it. */
export const FolderNodeRow = memo(function FolderNodeRow(
  props: FolderRowContext & {
    readonly node: FolderNode;
    readonly depth: number;
    readonly ancestorPath: string;
  },
) {
  const { folder, children } = props.node;
  const path = props.ancestorPath ? `${props.ancestorPath} / ${folder.name}` : folder.name;
  const collapsed = props.collapsed.has(folder.id);
  const { onAction, onSelect, onToggle } = props;
  const handleMenu = useCallback(
    (event: MenuEvent) => onAction(folder, event.nativeEvent.event),
    [folder, onAction],
  );
  const handleSelect = useCallback(() => onSelect(folder), [folder, onSelect]);
  return (
    <View>
      <LevelRow
        depth={props.depth}
        icon="folder"
        name={folder.name}
        accessibilityLabel={`Threads in ${path}`}
        count={props.counts.get(folder.id) ?? 0}
        summary={props.summaries.get(folder.id) ?? null}
        origin={folder.origin?.name}
        selected={props.selectedFolderId === folder.id}
        onSelect={handleSelect}
        leading={
          children.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={collapsed ? `Show folders in ${path}` : `Hide folders in ${path}`}
              accessibilityState={{ expanded: !collapsed }}
              className="size-10 items-center justify-center rounded-full active:bg-subtle-strong"
              onPress={() => onToggle(folder)}
            >
              <SymbolView
                name={collapsed ? "chevron.right" : "chevron.down"}
                size={12}
                tintColorClassName="accent-icon-muted"
              />
            </Pressable>
          ) : null
        }
        menu={
          <RowMenu
            label={path}
            actions={props.menus.get(folder.id) ?? NO_ACTIONS}
            onPressAction={handleMenu}
          />
        }
      />
      {collapsed
        ? null
        : children.map((child) => (
            <FolderNodeRow
              key={child.folder.id}
              {...props}
              node={child}
              depth={props.depth + 1}
              ancestorPath={path}
            />
          ))}
    </View>
  );
});
