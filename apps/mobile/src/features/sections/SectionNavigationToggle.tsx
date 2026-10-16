import { useAtomValue } from "@effect/atom-react";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { Atom } from "effect/reactivity";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { ControlPill } from "../../components/ui/ControlPill";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { navigationToggleCopy } from "../folders/panel-copy";

// signalbox: the label follows the panel's own copy (folders on the cloud).
const toggleCopyAtom = Atom.make((get) =>
  navigationToggleCopy(
    [...get(environmentServerConfigsAtom).values()].map(
      (config) => config.environment.capabilities,
    ),
  ),
).pipe(Atom.withLabel("mobile:section-toggle-copy"));

function sectionToggleLabel(open: boolean, copy = appAtomRegistry.get(toggleCopyAtom)): string {
  return open ? copy.hide : copy.show;
}

export function sectionToggleSfSymbol(open: boolean): "folder.fill" | "folder" {
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
  const accessibilityLabel = sectionToggleLabel(props.open, useAtomValue(toggleCopyAtom));
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
