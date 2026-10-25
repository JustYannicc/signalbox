/**
 * The New button pinned above every sidebar view. A click opens quick capture
 * (`capture.open`); Shift+click goes straight to a full draft in the current
 * project.
 */
import { useAtomValue } from "@effect/atom-react";
import { SquarePenIcon } from "lucide-react";
import { type MouseEvent as ReactMouseEvent } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { openQuickCapture } from "../capture/quickCaptureStore";
import { Kbd } from "../ui/kbd";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function SidebarNewButton() {
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "capture.open");

  const handleNew = (event: ReactMouseEvent) => {
    if (isMobile) setOpenMobile(false);
    if (!event.shiftKey) {
      openQuickCapture();
      return;
    }
    void startNewThreadFromContext({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
  };

  return (
    <div className="shrink-0 px-2 pt-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton className="group/new-chat" onClick={handleNew}>
            <SquarePenIcon />
            <span className="min-w-0 flex-1 truncate text-sidebar-foreground">New</span>
            {shortcut ? (
              <span className="opacity-0 transition-opacity group-hover/new-chat:opacity-100">
                <Kbd>{shortcut}</Kbd>
              </span>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
}
