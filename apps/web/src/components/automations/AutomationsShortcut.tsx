/**
 * The `automations.open` keybinding (mod+alt+w by default): opens the
 * overview with the Automations panel in the sidebar, the same as the palette
 * entry. Lives here so CommandPalette's own key handler stays upstream's.
 */
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useOpenAutomations } from "./useOpenAutomation";

export function AutomationsShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openAutomations = useOpenAutomations();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "automations.open") return;
      event.preventDefault();
      event.stopPropagation();
      void openAutomations();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, openAutomations]);

  return null;
}
