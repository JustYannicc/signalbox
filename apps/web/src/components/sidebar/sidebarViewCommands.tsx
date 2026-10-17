import { useAtomValue } from "@effect/atom-react";
import { useLocation, useParams } from "@tanstack/react-router";
import { HouseIcon } from "lucide-react";
import { useCallback, useEffect } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { useSidebarView, type SidebarView } from "./sidebarView";

export function useSidebarViewNavigation() {
  const [view, setView] = useSidebarView();
  const navigateToMainApp = useNavigateToMainApp();
  const onUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const changeView = useCallback(
    (next: SidebarView) => {
      setView(next);
      if (onUtilityPage) void navigateToMainApp();
    },
    [navigateToMainApp, onUtilityPage, setView],
  );
  return { view, changeView };
}

export function useSidebarViewPaletteItems(): CommandPaletteActionItem[] {
  const { changeView } = useSidebarViewNavigation();
  return [
    {
      kind: "action",
      value: "action:go-home",
      title: "Go to Home",
      // The palette matches searchTerms only, never the title.
      searchTerms: ["go to home", "home", "view", "sidebar", "folders"],
      icon: <HouseIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "sidebar.home",
      run: async () => changeView("home"),
    },
  ];
}

export function SidebarViewShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { changeView } = useSidebarViewNavigation();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        isCommandPaletteOpen() ||
        (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeThreadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                routeThreadRef,
              ).terminalOpen
            : false,
          previewFocus: isPreviewFocused(),
          previewOpen: routeThreadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "sidebar.home") return;
      event.preventDefault();
      event.stopPropagation();
      changeView("home");
    };
    window.addEventListener("keydown", onKeyDown);
    const unsubscribe = window.desktopBridge?.onMenuAction((command) => {
      if (command === "sidebar.home" && !isCommandPaletteOpen()) changeView("home");
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribe?.();
    };
  }, [keybindings, changeView, routeThreadRef]);

  return null;
}
