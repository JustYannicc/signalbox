/**
 * Mounted once with the app shell, on every route. Shows quick capture and
 * opens it on `capture.open` (default mod+shift+space).
 */
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { QuickCaptureDialog } from "./QuickCaptureDialog";
import { openQuickCapture, useQuickCaptureStore } from "./quickCaptureStore";

export function QuickCaptureHost() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const open = useQuickCaptureStore((state) => state.open);
  const openCount = useQuickCaptureStore((state) => state.openCount);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "capture.open") return;
      event.preventDefault();
      event.stopPropagation();
      openQuickCapture();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [keybindings]);

  // Nothing mounts until the first opening.
  return openCount > 0 ? <QuickCaptureDialog key={openCount} open={open} /> : null;
}
