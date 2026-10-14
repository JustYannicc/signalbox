// signalbox: one row per level of an owner's tree: its top level, then its folders, nested.
import type { FolderNode } from "@t3tools/client-runtime/state/signalboxFolders";
import type { MenuAction } from "@react-native-menu/menu";
import type { Folder } from "@t3tools/contracts/signalboxFolders";
import { memo, useCallback, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";

const MAX_VISUAL_DEPTH = 5;

type MenuEvent = { readonly nativeEvent: { readonly event: string } };

/** A row's ⋯ button and its native menu. */
function RowMenu(props: {
  readonly label: string;
  readonly actions: ReadonlyArray<MenuAction>;
  readonly onPressAction: (event: MenuEvent) => void;
}) {
  if (props.actions.length === 0) return null;
  return (
    <ControlPillMenu
      actions={[...props.actions]}
      onPressAction={props.onPressAction}
      title={props.label}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${props.label}`}
        className="size-10 items-center justify-center rounded-full active:bg-subtle-strong"
      >
        <SymbolView name="ellipsis" size={16} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </ControlPillMenu>
  );
}

/** A selectable level: name, how many threads live right there, and a menu. */
function LevelRow(props: {
  readonly depth: number;
  readonly icon: "folder" | "folder.fill";
  readonly name: string;
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
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 py-1 active:opacity-75"
        onPress={props.onSelect}
      >
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName={props.selected ? "accent-primary" : "accent-icon-muted"}
        />
        <AppText
          className={
            props.depth === 0
              ? "min-w-0 flex-1 font-t3-medium text-foreground"
              : "min-w-0 flex-1 text-sm text-foreground"
          }
          numberOfLines={1}
        >
          {props.name}
        </AppText>
        {props.count > 0 ? (
          <AppText className="text-xs tabular-nums text-foreground-muted">{props.count}</AppText>
        ) : null}
      </Pressable>
      {props.menu}
    </View>
  );
}

export const OwnerTopLevelRow = memo(function OwnerTopLevelRow(props: {
  readonly name: string;
  readonly count: number;
  readonly selected: boolean;
  readonly actions: ReadonlyArray<MenuAction>;
  readonly onSelect: () => void;
  readonly onAction: (event: string) => void;
}) {
  const onAction = props.onAction;
  const handleMenu = useCallback(
    (event: MenuEvent) => onAction(event.nativeEvent.event),
    [onAction],
  );
  return (
    <LevelRow
      depth={0}
      icon="folder.fill"
      name={props.name}
      accessibilityLabel={`Threads at the top level of ${props.name}`}
      count={props.count}
      selected={props.selected}
      onSelect={props.onSelect}
      menu={<RowMenu label={props.name} actions={props.actions} onPressAction={handleMenu} />}
    />
  );
});

export interface FolderRowContext {
  readonly counts: ReadonlyMap<string, number>;
  readonly selectedFolderId: string | null;
  readonly collapsed: ReadonlySet<string>;
  readonly menuFor: (folder: Folder) => ReadonlyArray<MenuAction>;
  readonly onSelect: (folder: Folder) => void;
  readonly onToggle: (folder: Folder) => void;
  readonly onAction: (folder: Folder, event: string) => void;
}

/** A folder and, unless collapsed, the folders inside it. */
export function FolderNodeRow(
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
  return (
    <View>
      <LevelRow
        depth={props.depth}
        icon="folder"
        name={folder.name}
        accessibilityLabel={`Threads in ${path}`}
        count={props.counts.get(folder.id) ?? 0}
        selected={props.selectedFolderId === folder.id}
        onSelect={() => onSelect(folder)}
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
        menu={<RowMenu label={path} actions={props.menuFor(folder)} onPressAction={handleMenu} />}
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
}
