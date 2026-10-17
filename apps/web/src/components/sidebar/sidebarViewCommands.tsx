import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { HouseIcon } from "lucide-react";
import { useCallback, useEffect } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
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
      searchTerms: ["view", "sidebar", "folders"],
      icon: <HouseIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "sidebar.home",
      run: async () => changeView("home"),
    },
  ];
}

export function SidebarViewShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { changeView } = useSidebarViewNavigation();

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
        context: { terminalFocus: isTerminalFocused() },
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
  }, [keybindings, changeView]);

  return null;
}
