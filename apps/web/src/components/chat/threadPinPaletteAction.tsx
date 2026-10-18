import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type KeybindingCommand } from "@t3tools/contracts";
import { PinIcon, PinOffIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useEnvironmentScope } from "../../state/session";
import type { ThreadShell } from "../../types";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useThreadPinPaletteAction(
  activeThread: ThreadShell | null,
  pinSupported: boolean,
  setOpen: (open: boolean) => void,
) {
  const { pinThread, confirmAndUnpinThread } = useThreadActions();
  const canOperate = useEnvironmentScope(
    activeThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canToggle = activeThread !== null && pinSupported && canOperate;
  const isPinned = activeThread?.pinnedAt != null;
  const togglePin = async () => {
    if (!activeThread || !canToggle) return;
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const result = await (isPinned ? confirmAndUnpinThread(threadRef) : pinThread(threadRef));
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: isPinned ? "Failed to unpin thread" : "Failed to pin thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const run = useStableCallback(togglePin);
  const items: Array<CommandPaletteActionItem> =
    activeThread?.id && canToggle
      ? [
          {
            kind: "action",
            value: "action:toggle-thread-pin",
            searchTerms: [isPinned ? "unpin" : "pin", "thread", "current"],
            title: isPinned ? "Unpin thread" : "Pin thread",
            icon: isPinned ? (
              <PinOffIcon className={ITEM_ICON_CLASS} />
            ) : (
              <PinIcon className={ITEM_ICON_CLASS} />
            ),
            shortcutCommand: "thread.pin",
            run,
          },
        ]
      : [];

  function handleKey(event: KeyboardEvent<HTMLInputElement>, command: KeybindingCommand | null) {
    if (command !== "thread.pin" || !activeThread?.id || event.nativeEvent.isComposing)
      return false;
    event.preventDefault();
    event.stopPropagation();
    if (canToggle) {
      setOpen(false);
      void togglePin();
    }
    return true;
  }

  return { items, handleKey };
}
