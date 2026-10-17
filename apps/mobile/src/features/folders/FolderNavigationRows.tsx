// signalbox: one row per level of an owner's tree: its top level, then its folders, nested.
import type { FolderNode } from "@t3tools/client-runtime/state/signalboxFolders";
import type { MenuAction } from "@react-native-menu/menu";
import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import type { Folder, FolderId } from "@t3tools/contracts/signalboxFolders";
import { memo, useCallback, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";

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

/** A selectable level: its name, how many threads are in it or below, and a menu. */
function LevelRow(props: {
  readonly depth: number;
  readonly icon: "folder" | "folder.fill";
  readonly name: string;
  readonly subtitle?: string;
  readonly accessibilityLabel: string;
  readonly count: number;
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
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ selected: props.selected }}
        className={cn(
          "min-w-0 flex-1 flex-row items-center gap-2 py-1 active:opacity-75",
          props.subtitle ? "min-h-13" : "min-h-11",
        )}
        onPress={props.onSelect}
        accessibilityHint={props.subtitle ? `Based on ${props.subtitle}` : undefined}
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
          {props.subtitle ? (
            <AppText className="text-xs text-foreground-muted" numberOfLines={1}>
              Based on {props.subtitle}
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

/** An owner's top level: the threads that aren't in any of its folders. */
export const OwnerTopLevelRow = memo(function OwnerTopLevelRow(props: {
  readonly owner: SignalboxContext;
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
  return (
    <LevelRow
      depth={0}
      icon="folder.fill"
      name={owner.name}
      accessibilityLabel={`Threads at the top level of ${owner.name}`}
      count={0}
      selected={props.selected}
      onSelect={handleSelect}
      menu={<RowMenu label={owner.name} actions={props.actions} onPressAction={handleMenu} />}
    />
  );
});

export interface FolderRowContext {
  readonly counts: ReadonlyMap<FolderId, number>;
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
        subtitle={folder.origin?.name}
        accessibilityLabel={`Threads in ${path}`}
        count={props.counts.get(folder.id) ?? 0}
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
