/**
 * Home's New button. Same behavior as Pipeline's new-thread button and
 * `chat.new`: with one project it creates right away, with several it opens the
 * command palette's "New thread in..." picker, and Shift+click creates in the
 * current project.
 */
import { useAtomValue } from "@effect/atom-react";
import { SquarePenIcon } from "lucide-react";
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { useProjects } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { shouldCreateNewThreadInCurrentProject } from "../Sidebar.logic";
import { Kbd } from "../ui/kbd";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function HomeNewButton() {
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const projectCount = useProjects().length;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectCount <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);

  const handleNew = useCallback(
    (event: ReactMouseEvent) => {
      if (isMobile) setOpenMobile(false);
      if (shouldCreateNewThreadInCurrentProject(event.shiftKey, projectCount)) {
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
        return;
      }
      openCommandPalette({ open: "new-thread-in" });
    },
    [isMobile, newThreadContext, projectCount, setOpenMobile],
  );

  return (
    <div className="shrink-0 px-2 pt-1">
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
