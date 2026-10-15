// signalbox: the iOS workspace's sections toggle. Home renders the panel; the
// toggle sits in the workspace's own bars, beside Settings or beside compose.
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Platform } from "react-native";

import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import type { WorkspaceTab } from "../workspace/workspace-tabs-state";
import { sectionToggleSfSymbol } from "./SectionNavigationToggle";
import { sectionsPanelCopyAtom, sectionsPanelOpenAtom } from "./sections-panel-state";

/** One header bar button and its spacing. */
const HEADER_BUTTON_WIDTH = 48;

/**
 * Sidebars (iPad, iPhone with a side bar) are too narrow for a third header
 * button, so the toggle joins compose in the bottom toolbar there. Mirrors
 * `nativeToolbarCompose` in WorkspaceToolbar.ios.tsx.
 */
function useTogglesFromToolbar() {
  const metrics = useNativeLayoutMetrics();
  return (
    Platform.OS === "ios" && (Platform.isPad || (metrics?.verticalBarEdge ?? "none") !== "none")
  );
}

/**
 * Room the workspace title leaves for the toggle while it shares the header.
 * The title is a fixed-width bar item, so without it the title swallows the
 * toggle's taps.
 */
export function useWorkspaceSectionsTitleInset(selectedTab: WorkspaceTab): number {
  const fromToolbar = useTogglesFromToolbar();
  return Platform.OS === "ios" && selectedTab === "threads" && !fromToolbar
    ? HEADER_BUTTON_WIDTH
    : 0;
}

/** The toggle as a bar button for the header or the bottom toolbar, on the Threads tab only. */
export function useWorkspaceSectionsToggle(selectedTab: WorkspaceTab) {
  const [open, setOpen] = useAtom(sectionsPanelOpenAtom);
  const copy = useAtomValue(sectionsPanelCopyAtom);
  const fromToolbar = useTogglesFromToolbar();
  const button =
    selectedTab === "threads" ? (
      <NativeHeaderToolbar.Button
        accessibilityLabel={open ? copy.hide : copy.show}
        icon={sectionToggleSfSymbol(open)}
        identifier="workspace-sections"
        onPress={() => setOpen((current) => !current)}
        separateBackground={fromToolbar}
      />
    ) : null;
  return { header: fromToolbar ? null : button, toolbar: fromToolbar ? button : null };
}
