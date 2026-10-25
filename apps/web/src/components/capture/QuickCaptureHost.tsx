/**
 * Mounted once with the app shell, on every route. Shows quick capture and
 * opens it on `capture.open` (default mod+shift+space).
 */
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { QuickCaptureDialog } from "./QuickCaptureDialog";
import { openQuickCapture, useQuickCaptureStore } from "./quickCaptureStore";

export function QuickCaptureHost() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const open = useQuickCaptureStore((state) => state.open);
  const openCount = useQuickCaptureStore((state) => state.openCount);
  const routeThreadRef = useParams({ strict: false, select: resolveThreadRouteRef });
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isCommandPaletteOpen()) return;
      // Recording a shortcut in Settings gets the keys, not quick capture.
      if (event.target instanceof Element && event.target.closest("[data-keybinding-capture]")) {
        return;
      }
      // The same context the chat route's shortcuts see, so a custom `when` means the same here.
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
          usagePageOpen,
        },
      });
      if (command !== "capture.open") return;
      event.preventDefault();
      event.stopPropagation();
      openQuickCapture();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [keybindings, routeThreadRef, usagePageOpen]);

  // Nothing mounts until the first opening.
  return openCount > 0 ? <QuickCaptureDialog key={openCount} open={open} /> : null;
}
