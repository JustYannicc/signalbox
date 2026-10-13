import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { ControlPill } from "../../components/ControlPill";
import type { AppSymbolName } from "../../components/AppSymbol";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

function sectionToggleLabel(open: boolean): string {
  return open ? "Hide sections" : "Browse sections";
}

function sectionToggleSfSymbol(open: boolean): "folder.fill" | "folder" {
  return open ? "folder.fill" : "folder";
}

function sectionToggleAppSymbol(open: boolean): AppSymbolName {
  return {
    ios: sectionToggleSfSymbol(open),
    android: open ? "folder_open" : "folder",
  };
}

export function SectionNavigationToggle(props: {
  readonly open: boolean;
  readonly onPress: () => void;
  readonly variant: "android-header" | "native-toolbar" | "pill";
}) {
  const accessibilityLabel = sectionToggleLabel(props.open);
  if (props.variant === "android-header") {
    return (
      <AndroidHeaderIconButton
        accessibilityLabel={accessibilityLabel}
        icon={sectionToggleAppSymbol(props.open)}
        onPress={props.onPress}
        selected={props.open}
      />
    );
  }
  if (props.variant === "native-toolbar") {
    return (
      <NativeHeaderToolbar.Button
        accessibilityLabel={accessibilityLabel}
        icon={sectionToggleSfSymbol(props.open)}
        onPress={props.onPress}
        separateBackground
      />
    );
  }
  return (
    <ControlPill
      accessibilityLabel={accessibilityLabel}
      className={props.open ? "bg-subtle-strong" : undefined}
      icon={sectionToggleSfSymbol(props.open)}
      onPress={props.onPress}
    />
  );
}

export function createSectionNavigationHeaderItem(input: {
  readonly open: boolean;
  readonly onPress: () => void;
  readonly identifier?: string;
}): NativeStackHeaderItem {
  return withNativeGlassHeaderItem({
    type: "button",
    label: "",
    accessibilityLabel: sectionToggleLabel(input.open),
    icon: { type: "sfSymbol" as const, name: sectionToggleSfSymbol(input.open) },
    onPress: input.onPress,
    ...(input.identifier === undefined ? {} : { identifier: input.identifier }),
  });
}
