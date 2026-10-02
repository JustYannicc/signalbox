import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import {
  resolveShortcutCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { resolveAdjacentThreadId } from "../Sidebar.logic";
import { homeThreadKey } from "./useHomeSidebarData";

/**
 * Next/previous thread and jump-to-N while Home is the open view. The Pipeline
 * binds the same commands over its own order; only one of them is mounted.
 */
export function useHomeThreadShortcuts(input: {
  orderedThreads: readonly EnvironmentThreadShell[];
  activeThreadKey: string | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { orderedThreads, activeThreadKey, onOpenThread } = input;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useParams({ strict: false, select: resolveThreadRouteRef });
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  useEffect(() => {
    const threadKeys = orderedThreads.map(homeThreadKey);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const direction = threadTraversalDirectionFromCommand(command);
      const targetKey =
        direction !== null
          ? resolveAdjacentThreadId({
              threadIds: threadKeys,
              currentThreadId: activeThreadKey,
              direction,
            })
          : (threadKeys[threadJumpIndexFromCommand(command ?? "") ?? -1] ?? null);
      const target = targetKey ? orderedThreads[threadKeys.indexOf(targetKey)] : undefined;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenThread(scopeThreadRef(target.environmentId, target.id));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeThreadKey, keybindings, onOpenThread, orderedThreads, routeTerminalOpen]);
}
