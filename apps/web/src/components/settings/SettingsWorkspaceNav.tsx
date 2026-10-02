/**
 * Fork: organization pages that live under Settings instead of the rail — the
 * team, the machines chats run on, and on-demand computers.
 */
import { useNavigate } from "@tanstack/react-router";
import { MonitorPlayIcon, ServerIcon, UsersIcon } from "lucide-react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

const WORKSPACE_ITEMS = [
  { to: "/team", label: "Team", icon: UsersIcon },
  { to: "/devices", label: "Devices", icon: ServerIcon },
  { to: "/computers", label: "Computers", icon: MonitorPlayIcon },
] as const;

export const SETTINGS_WORKSPACE_PATHS: ReadonlyArray<string> = WORKSPACE_ITEMS.map(
  (item) => item.to,
);

/** True on a workspace page, which shows the settings navigation beside it. */
export function isSettingsWorkspacePath(pathname: string): boolean {
  return SETTINGS_WORKSPACE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function SettingsWorkspaceNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <div className="flex flex-col gap-1 pt-4">
      <h3 className="px-2.5 text-xs font-medium text-sidebar-muted-foreground/70">Organization</h3>
      <SidebarMenu>
        {WORKSPACE_ITEMS.map(({ to, label, icon: Icon }) => (
          <SidebarMenuItem key={to}>
            <SidebarMenuButton
              isActive={pathname === to || pathname.startsWith(`${to}/`)}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                // Sibling settings pages replace each other, like the settings nav above.
                void navigate({ to, replace: true });
              }}
            >
              <Icon />
              <span className="truncate">{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </div>
  );
}
