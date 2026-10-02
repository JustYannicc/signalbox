/**
 * The two entries pinned above every sidebar view: New, which opens the New
 * bar (capture, or mod+Enter for a full chat draft; Shift-click skips straight
 * to the draft like `chat.new`), and the assistant for handing things off.
 */
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { SquarePenIcon } from "lucide-react";
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { AssistantIcon, useAssistantIdentity } from "../assistant/assistantIdentity";
import { openQuickCapture } from "../capture/QuickCaptureHost";
import { Kbd } from "../ui/kbd";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function SidebarQuickActions() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const assistantOpen = useLocation({
    select: (location) =>
      location.pathname === "/assistant" || location.pathname.startsWith("/assistant/"),
  });
  const newShortcut = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "capture.open",
  );
  const assistant = useAssistantIdentity();

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  // Plain click opens the New bar; Shift goes straight to a full chat draft in
  // the current project, same as the `chat.new` keybinding.
  const handleNew = useCallback(
    (event: ReactMouseEvent) => {
      closeMobileSidebar();
      if (event.shiftKey) {
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
        return;
      }
      openQuickCapture({ source: "new-button" });
    },
    [closeMobileSidebar, newThreadContext],
  );

  return (
    <div className="shrink-0 px-2 pt-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton className="group/new-chat" onClick={handleNew}>
            <SquarePenIcon />
            <span className="min-w-0 flex-1 truncate text-sidebar-foreground">New</span>
            {newShortcut ? (
              <span className="opacity-0 transition-opacity group-hover/new-chat:opacity-100">
                <Kbd>{newShortcut}</Kbd>
              </span>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={assistantOpen}
            onClick={() => {
              closeMobileSidebar();
              void navigate({ to: "/assistant" });
            }}
          >
            {/* Wrapped: the menu button forces bare child svgs to 16px. */}
            <span className="-ml-1 flex shrink-0">
              <AssistantIcon size={24} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
              {assistant.name}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
}
