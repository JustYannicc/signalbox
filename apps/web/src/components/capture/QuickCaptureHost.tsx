/**
 * Mount once in the app layout. Owns the New bar's open state and opens it on
 * the `capture.open` keybinding (default mod+shift+space) or
 * `openQuickCapture()` (the sidebar New button, Home "+" buttons). What you
 * typed persists in `captureDraftStore` between opens; each open sets the
 * assistant chip from its source (see `OpenQuickCaptureSource`).
 */
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useState } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { useCaptureDraftStore } from "./captureDraftStore";
import { onOpenQuickCapture, type OpenQuickCaptureOptions } from "./captureModel";
import { ASSISTANT_TOKEN_ID, assistantToken } from "./captureTokens";
import { QuickCaptureForm } from "./QuickCaptureForm";

export {
  openQuickCapture,
  type OpenQuickCaptureOptions,
  type OpenQuickCaptureSource,
} from "./captureModel";

export function QuickCaptureHost() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const assistantName = useAssistantIdentity().name;
  const [open, setOpen] = useState(false);
  // Remount the form per open so it re-reads the persisted draft and focus lands in the field.
  const [session, setSession] = useState(0);

  const show = useCallback(
    (options: OpenQuickCaptureOptions) => {
      const store = useCaptureDraftStore.getState();
      const source = options.source ?? "elsewhere";
      if (options.tokens?.length) store.addTokens(options.tokens);
      // In-app New starts a chat; elsewhere the assistant is the default target.
      // Tagged opens (Home "+") and resumes keep whatever chips they carry.
      if (source === "new-button") store.removeToken(ASSISTANT_TOKEN_ID);
      else if (source !== "resume" && !options.tokens?.length) {
        store.addTokens([assistantToken(assistantName)]);
      }
      setSession((value) => value + 1);
      setOpen(true);
    },
    [assistantName],
  );

  useEffect(() => {
    return onOpenQuickCapture(show);
  }, [show]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, keybindings) !== "capture.open") return;
      event.preventDefault();
      event.stopPropagation();
      show({ source: "hotkey" });
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [keybindings, show]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup aria-label="New" data-quick-capture="">
        <QuickCaptureForm key={session} onClose={() => setOpen(false)} />
      </CommandDialogPopup>
    </CommandDialog>
  );
}
