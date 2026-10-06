import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView, type SFSymbol } from "../components/AppSymbol";
import { ControlPillMenu } from "../components/ControlPill";

export interface HeaderMenuAction {
  readonly id: string;
  readonly title: string;
  /** SF Symbol shown beside the action on iOS. */
  readonly icon?: SFSymbol;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}

export interface HeaderMenuGroup {
  readonly id: string;
  /** A titled group opens as a submenu; an untitled one sits inline. */
  readonly title?: string;
  readonly actions: ReadonlyArray<HeaderMenuAction>;
}

export interface HeaderButton {
  readonly accessibilityLabel: string;
  readonly icon: "plus" | "ellipsis.circle" | "line.3.horizontal.decrease.circle";
  readonly onPress: () => void;
}

interface HeaderMenuInput {
  readonly title: string;
  readonly icon: HeaderButton["icon"];
  readonly groups: ReadonlyArray<HeaderMenuGroup>;
  readonly buttons?: ReadonlyArray<HeaderButton>;
}

/** What the header shows, without its handlers. */
interface HeaderShape {
  readonly title: string;
  readonly icon: HeaderButton["icon"];
  readonly actions: MenuAction[];
  readonly buttons: ReadonlyArray<Pick<HeaderButton, "accessibilityLabel" | "icon">>;
}

function menuAction(action: HeaderMenuAction): MenuAction {
  return {
    id: action.id,
    title: action.title,
    image: Platform.OS === "ios" ? action.icon : undefined,
    state: action.selected ? "on" : undefined,
    attributes:
      action.disabled || action.destructive
        ? { disabled: action.disabled, destructive: action.destructive }
        : undefined,
  };
}

function toMenuActions(groups: ReadonlyArray<HeaderMenuGroup>): MenuAction[] {
  return groups.flatMap((group): MenuAction[] =>
    group.title
      ? [{ id: group.id, title: group.title, subactions: group.actions.map(menuAction) }]
      : Platform.OS === "ios"
        ? [
            {
              id: group.id,
              title: "",
              displayInline: true,
              subactions: group.actions.map(menuAction),
            },
          ]
        : group.actions.map(menuAction),
  );
}

function headerShape(input: HeaderMenuInput): HeaderShape {
  return {
    title: input.title,
    icon: input.icon,
    actions: toMenuActions(input.groups),
    buttons: (input.buttons ?? []).map(({ accessibilityLabel, icon }) => ({
      accessibilityLabel,
      icon,
    })),
  };
}

const ICON_BUTTON_CLASS = Platform.OS === "ios" ? "size-[28px]" : "size-[44px]";

function HeaderControls(props: {
  readonly shape: HeaderShape;
  readonly latest: RefObject<HeaderMenuInput>;
}) {
  const { shape, latest } = props;
  const onAction = (id: string) => {
    const action = latest.current.groups
      .flatMap((group) => group.actions)
      .find((candidate) => candidate.id === id);
    if (action && !action.disabled) action.onPress();
  };
  return (
    <View className="flex-row items-center gap-2">
      {shape.buttons.map((button, index) => (
        <Pressable
          key={button.accessibilityLabel}
          accessibilityRole="button"
          accessibilityLabel={button.accessibilityLabel}
          hitSlop={8}
          onPress={() => latest.current.buttons?.[index]?.onPress()}
          className={`${ICON_BUTTON_CLASS} items-center justify-center rounded-full`}
        >
          <SymbolView name={button.icon} size={22} tintColorClassName="accent-icon" />
        </Pressable>
      ))}
      <ControlPillMenu
        accessible
        accessibilityRole="button"
        accessibilityLabel={shape.title}
        title={shape.title}
        isAnchoredToRight
        actions={shape.actions}
        onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={shape.title}
          className={`${ICON_BUTTON_CLASS} items-center justify-center rounded-full`}
        >
          <SymbolView name={shape.icon} size={22} tintColorClassName="accent-icon" />
        </Pressable>
      </ControlPillMenu>
    </View>
  );
}

/**
 * Header-right controls: optional buttons and one overflow menu. Both
 * platforms keep the native header, so this goes through `headerRight` like
 * Usage's filter. Handlers are read from a ref when pressed, so the header
 * only re-renders when what it shows changes.
 */
export function useHeaderMenu(input: HeaderMenuInput) {
  const navigation = useNavigation();
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const next = headerShape(input);
  const key = JSON.stringify(next);
  // Keep the shown shape until what it shows changes, so the header doesn't re-render per render.
  const [shown, setShown] = useState({ key, shape: next });
  if (shown.key !== key) setShown({ key, shape: next });

  const header = useMemo(
    () => <HeaderControls shape={shown.shape} latest={latest} />,
    [shown.shape],
  );
  const empty = input.groups.every((group) => group.actions.length === 0) && !input.buttons?.length;
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: empty ? undefined : () => header });
  }, [navigation, header, empty]);
}
